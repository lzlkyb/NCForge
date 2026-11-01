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

async function refreshThreads(): Promise<void> {
  if (snap.status.state !== "attached") return;
  try {
    const list = (await debugThreads()).threads ?? [];
    set({ threads: list });
  } catch {
    // 线程列表只服务「暂停」按钮；拿不到就把按钮留着禁用态
  }
}

function onEvent(e: DebugEvent): void {
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
    const wasAttached = snap.status.state === "attached";
    set({ status: s, ...(s.state === "attached" ? {} : idle()) });
    if (s.state === "attached" && !wasAttached) {
      void syncBreakpoints();
      void refreshThreads();
    }
    if (s.state !== "attached" && wasAttached) resetBreakpointSync();
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
    set({ status: stoppedStatus, ...idle(), busy: null });
    resetBreakpointSync();
  } catch (e) {
    set({ busy: null, error: errText(e) });
    throw e;
  }
}

export async function resumeDebug(): Promise<void> {
  const threadId = snap.threadId;
  if (!snap.paused || !threadId) return;
  set(idle());
  try {
    await debugContinue(threadId);
  } catch (e) {
    set({ error: errText(e) });
  }
}

export async function stepDebug(kind: Exclude<DebugAction, "resume">): Promise<void> {
  const threadId = snap.threadId;
  if (!snap.paused || !threadId) return;
  // 先松开 paused：步过要等下一次 stopped 事件，界面不能在这期间一直显示「已暂停」
  set(idle());
  try {
    await debugStep(threadId, kind);
  } catch (e) {
    set({ error: errText(e) });
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
