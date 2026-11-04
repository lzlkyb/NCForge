// 调试会话的前端镜像。
//
// 后端（`commands/debug_cmds.rs`）持有 DAP 连接与会话状态；这里只做三件事：
// 1. 把 `debug-status` / `debug-event` 收成 React 能用的快照；
// 2. 把「暂停 → 拉调用栈 → 选中帧 → 拉变量」串成一次动作（面板与 gutter 共用）。
//
// 断点下发在 `debugSync.ts`：触发源不同（用户改断点 vs DAP 事件），不混在一个状态机里。
// 路径口径：进出都是真实路径；影子工程只在 Rust 内部，前端永远不该看到。
import { useEffect, useSyncExternalStore } from "react";
import { setSession } from "./workspaceSession";
import { toggleBreakpointAt } from "./breakpoints";
import {
  debugContinue,
  debugEvaluate,
  debugPause,
  debugScopes,
  debugStackTrace,
  debugStart,
  debugStatus,
  debugStep,
  debugStop,
  debugThreads,
  debugVariables,
  onDebugEvent,
  onDebugStatus,
} from "./debug";
import type { DapScope, DapStackFrame, DapThread, DapVariable, DebugEvent, DebugStatus } from "./debug";
import { applyBreakpointEvent, resetBreakpointSync, startBreakpointSync, syncBreakpoints } from "./debugSync";

export type DebugAction = "resume" | "over" | "into" | "out";

/** 一条监视表达式与其最近一次求值结果。 */
export interface DebugWatch {
  expression: string;
  result: string | null;
  type: string | null;
  error: string | null;
  evaluating: boolean;
}

/** 监视条数上限：再多就盖住变量区，而且 IDE 里也没人挂几十条。 */
export const MAX_DEBUG_WATCHES = 12;

export interface DebugSnapshot {
  status: DebugStatus;
  paused: boolean;
  threadId: number | null;
  threads: DapThread[];
  frames: DapStackFrame[];
  frameId: number | null;
  scopes: DapScope[];
  /** key = variablesReference（DAP 用数字字符串做键，读的时候能用数字索引）。 */
  variables: Record<number, DapVariable[]>;
  /** 监视表达式：只在本次调试会话内有效，断开即清。 */
  watches: DebugWatch[];
  /** 每次 stopped +1：同一帧连停两次也能让面板重新定位到编辑器。 */
  stopSeq: number;
  busy: "attach" | "detach" | null;
  error: string | null;
}

const stoppedStatus: DebugStatus = {
  state: "stopped",
  module: null,
  dapPort: null,
  jdwpPort: null,
  message: "",
};

let snap: DebugSnapshot = {
  status: stoppedStatus,
  paused: false,
  threadId: null,
  threads: [],
  frames: [],
  frameId: null,
  scopes: [],
  variables: {},
  watches: [],
  stopSeq: 0,
  busy: null,
  error: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<DebugSnapshot>): void {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export const getDebugSnapshot = (): DebugSnapshot => snap;
export const subscribeDebug = subscribe;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const idle = (): Partial<DebugSnapshot> => ({
  paused: false,
  threadId: null,
  threads: [],
  frames: [],
  frameId: null,
  scopes: [],
  variables: {},
  // 继续/断开后旧帧已经不存在：结果作废，但表达式留着，下次停住再算
  watches: snap.watches.map((w) => ({ ...w, result: null, type: null, error: null, evaluating: false })),
});

// ── 事件 → 快照 ────────────────────────────────────────────────────────────
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

async function loadStack(threadId: number, seq: number): Promise<void> {
  try {
    const r = await debugStackTrace(threadId);
    if (snap.stopSeq !== seq || !snap.paused) return;
    const frames = r.stackFrames ?? [];
    set({ frames });
    const first = frames.find((f) => f.id > 0);
    if (first) void selectFrame(first.id);
  } catch (e) {
    if (snap.stopSeq === seq) set({ error: errText(e) });
  }
}

export async function selectFrame(frameId: number): Promise<void> {
  set({ frameId, scopes: [], variables: {} });
  try {
    const scopes = (await debugScopes(frameId)).scopes ?? [];
    if (snap.frameId !== frameId) return;
    set({ scopes });
    const entries = await Promise.all(
      scopes.map(async (s) => {
        try {
          return [s.variablesReference, (await debugVariables(s.variablesReference)).variables ?? []] as const;
        } catch {
          return [s.variablesReference, []] as const;
        }
      }),
    );
    if (snap.frameId !== frameId) return;
    set({ variables: Object.fromEntries(entries) as Record<number, DapVariable[]> });
    refreshWatches(frameId);
  } catch (e) {
    if (snap.frameId === frameId) set({ error: errText(e) });
  }
}

/** 展开一个复合变量（变量树按需拉，别在暂停那一拍把整棵树全取回来）。 */
export async function expandVariables(ref: number): Promise<void> {
  if (ref <= 0 || snap.variables[ref]) return;
  try {
    const vars = (await debugVariables(ref)).variables ?? [];
    set({ variables: { ...snap.variables, [ref]: vars } });
  } catch (e) {
    set({ error: errText(e) });
  }
}

// ── 监视表达式 ─────────────────────────────────────────────────────────────
async function evaluateWatch(frameId: number, expression: string): Promise<void> {
  const apply = (patch: Partial<DebugWatch>): void => {
    // 求值是异步的：帧切走或已经继续运行时这次结果作废，
    // 否则会把旧帧的值贴到新上下文上，看起来像「当前帧算出来是这个」。
    if (snap.frameId !== frameId || !snap.paused) return;
    set({
      watches: snap.watches.map((w) => (w.expression === expression ? { ...w, ...patch } : w)),
    });
  };
  apply({ evaluating: true, error: null });
  try {
    const body = await debugEvaluate(expression, frameId);
    const result =
      typeof body.result === "string" ? body.result : body.result == null ? "" : JSON.stringify(body.result);
    apply({ evaluating: false, result, type: typeof body.type === "string" ? body.type : null });
  } catch (e) {
    apply({ evaluating: false, result: null, error: errText(e) });
  }
}

/** 每次停住/切换栈帧都把全部监视重算一遍（DAP 的求值上下文跟着 frame 走）。 */
function refreshWatches(frameId: number): void {
  if (!snap.paused || snap.watches.length === 0) return;
  for (const w of snap.watches) void evaluateWatch(frameId, w.expression);
}

export async function addWatch(expression: string): Promise<void> {
  const expr = expression.trim();
  if (!expr || snap.watches.some((w) => w.expression === expr)) return;
  if (snap.watches.length >= MAX_DEBUG_WATCHES) return;
  set({ watches: [...snap.watches, { expression: expr, result: null, type: null, error: null, evaluating: false }] });
  if (snap.paused && snap.frameId) await evaluateWatch(snap.frameId, expr);
}

export function removeWatch(expression: string): void {
  if (!snap.watches.some((w) => w.expression === expression)) return;
  set({ watches: snap.watches.filter((w) => w.expression !== expression) });
}

async function refreshThreads(): Promise<void> {
  if (snap.status.state !== "attached") return;
  try {
    const list = (await debugThreads()).threads ?? [];
    set({ threads: list });
  } catch {
    // 线程列表只服务「暂停」按钮；拿不到就把按钮留着禁用态
  }
}

let eventRevision = 0;
function onEvent(e: DebugEvent): void {
  if (["stopped", "continued", "terminated"].includes(e.event)) eventRevision++;
  const body = e.body ?? {};
  switch (e.event) {
    case "stopped": {
      const threadId = num(body.threadId);
      const seq = snap.stopSeq + 1;
      set({ ...idle(), paused: true, threadId, stopSeq: seq, error: null });
      if (threadId) void loadStack(threadId, seq);
      // 断住的瞬间把用户带到「调试」页签：不然调用栈要自己去找
      setSession({ panelOpen: true, panelTab: "debug" });
      break;
    }
    case "continued":
      set(idle());
      break;
    case "terminated":
      set(idle());
      break;
    case "breakpoint": {
      const b = body.breakpoint as { verified?: boolean; line?: number; source?: { path?: string } } | undefined;
      if (b?.source?.path && typeof b.line === "number") {
        applyBreakpointEvent(b.source.path, b.line, !!b.verified);
      }
      break;
    }
    case "thread":
      void refreshThreads();
      break;
    default:
      break;
  }
}

let listening = false;

function ensureListeners(): void {
  if (listening) return;
  listening = true;
  // 非 Tauri 环境（单测 / 浏览器预览）没有事件桥：订阅失败不该冒成未处理拒绝
  void onDebugStatus((s) => {
    if (snap.status.state !== s.state || snap.status.module !== s.module) eventRevision++;
    const wasAttached = snap.status.state === "attached";
    set({ status: s, ...(s.state === "attached" ? {} : idle()) });
    if (s.state === "attached" && !wasAttached) {
      void syncBreakpoints();
      void refreshThreads();
    }
    // 会话结束后监视表达式也不再有求值上下文：与「断开」按钮同一口径清掉
    if (s.state !== "attached" && wasAttached) {
      resetBreakpointSync();
      set({ watches: [] });
    }
  }).catch(() => {});
  void onDebugEvent(onEvent).catch(() => {});
  // 窗口重开/页面重挂时补一次真实状态：事件只覆盖变化，不覆盖「本来就是这样」
  void debugStatus()
    .then((s) => {
      if (s.state === "attached" && snap.status.state !== "attached") {
        set({ status: s });
        void syncBreakpoints();
        void refreshThreads();
      } else if (s.state !== "attached" && snap.status.state === "attached") {
        set({ status: s, ...idle() });
      }
    })
    .catch(() => {
      // 后端不可用时保持 stopped：界面仍有「附加调试器」入口
    });
  startBreakpointSync(() => snap.status.state === "attached");
}

export function useDebugSnapshot(): DebugSnapshot {
  const value = useSyncExternalStore(subscribe, getDebugSnapshot, getDebugSnapshot);
  useEffect(() => {
    ensureListeners();
  }, []);
  return value;
}

// ── 动作 ───────────────────────────────────────────────────────────────────
export async function attachDebugger(): Promise<void> {
  if (snap.status.state === "attached" || snap.busy) return;
  set({ busy: "attach", error: null });
  try {
    const status = await debugStart();
    set({ status, busy: null });
  } catch (e) {
    set({ busy: null, error: errText(e) });
    throw e;
  }
}

export async function detachDebugger(): Promise<void> {
  if (snap.status.state !== "attached" || snap.busy) return;
  set({ busy: "detach", error: null });
  try {
    await debugStop();
    set({ status: stoppedStatus, ...idle(), watches: [], busy: null });
    resetBreakpointSync();
  } catch (e) {
    set({ busy: null, error: errText(e) });
    throw e;
  }
}

export async function resumeDebug(): Promise<void> {
  const previous = snap;
  const revision = eventRevision;
  const threadId = snap.threadId;
  if (!snap.paused || !threadId) return;
  set(idle());
  try {
    await debugContinue(threadId);
  } catch (e) {
    // 请求失败且没有新的调试事件时恢复暂停位置，保留可重试的按钮和上下文。
    if (eventRevision === revision && snap.stopSeq === previous.stopSeq && snap.status.state === "attached") set({ ...previous, error: errText(e) });
    else set({ error: errText(e) });
  }
}

export async function stepDebug(kind: Exclude<DebugAction, "resume">): Promise<void> {
  const previous = snap;
  const revision = eventRevision;
  const threadId = snap.threadId;
  if (!snap.paused || !threadId) return;
  // 先松开 paused：步过要等下一次 stopped 事件，界面不能在这期间一直显示「已暂停」
  set(idle());
  try {
    await debugStep(threadId, kind);
  } catch (e) {
    // 请求失败且没有新的调试事件时恢复暂停位置，保留可重试的按钮和上下文。
    if (eventRevision === revision && snap.stopSeq === previous.stopSeq && snap.status.state === "attached") set({ ...previous, error: errText(e) });
    else set({ error: errText(e) });
  }
}

export async function pauseDebug(): Promise<void> {
  const threadId = snap.threadId ?? snap.threads.find((t) => t.id > 0)?.id ?? null;
  if (!threadId) return;
  try {
    await debugPause(threadId);
  } catch (e) {
    set({ error: errText(e) });
  }
}

/** 当前行加/去断点（gutter 点击与 Ctrl+F8 共用）。 */
export function toggleBreakpointHere(path: string, line: number): "added" | "removed" {
  return toggleBreakpointAt(path, line);
}

/** 单测用：直接把快照摆到「暂停在某一帧」，不依赖事件桥。 */
export function __setDebugFrameForTest(frameId: number | null): void {
  set({ paused: frameId !== null, frameId, scopes: [], variables: {} });
}
