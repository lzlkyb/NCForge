// 调试会话的前端镜像。
//
// 后端（`commands/debug_cmds.rs`）持有 DAP 连接与会话状态；这里只做三件事：
// 1. 把 `debug-status` / `debug-event` 收成 React 能用的快照（按中间件/客户端分槽）；
// 2. 把「暂停 → 拉调用栈 → 选中帧 → 拉变量」串成一次动作（面板与 gutter 共用）；
// 3. 记住当前面板正在看哪个目标：两个 JVM 各自暂停，切换时互不覆盖对方的状态。
//
// 断点下发在 `debugSync.ts`：触发源不同（用户改断点 vs DAP 事件），不混在一个状态机里。
// 路径口径：进出都是真实路径；影子工程只在 Rust 内部，前端永远不该看到。
import { useEffect, useSyncExternalStore } from "react";
import { setSession } from "./workspaceSession";
import { getWorkbenchLayout } from "./workbenchLayout";
import { prepareDebugSourceNavigation } from "./debugSourceNavigation";
import { toggleBreakpointAt } from "./breakpoints";
import {
  DEBUG_TARGETS,
  debugContinue,
  debugEvaluate,
  debugExceptionInfo,
  debugPause,
  debugScopes,
  debugSetExceptionBreakpoints,
  debugSetVariable,
  debugStackTrace,
  debugStart,
  debugStatus,
  debugStep,
  debugTargetLabel,
  debugStop,
  debugThreads,
  debugVariables,
  onDebugEvent,
  onDebugStatus,
} from "./debug";
import type {
  DapScope,
  DapStackFrame,
  DapThread,
  DapVariable,
  DebugEvent,
  DebugState,
  DebugStatus,
  DebugTarget,
  RemoteEndpoint,
} from "./debug";
import { applyBreakpointEvent, resetBreakpointSync, startBreakpointSync, syncBreakpoints } from "./debugSync";

export type DebugAction = "resume" | "over" | "into" | "out";
export type DebugBusy = "attach" | "detach" | null;

/** 一条监视表达式与其最近一次求值结果。 */
export interface DebugWatch {
  expression: string;
  result: string | null;
  type: string | null;
  error: string | null;
  evaluating: boolean;
}

/** 控制台里的一行：表达式 + 结果（或错误）。 */
export interface DebugConsoleEntry {
  id: number;
  expression: string;
  result: string | null;
  type: string | null;
  error: string | null;
  pending: boolean;
}

/** 异常停靠的现场（`exceptionInfo` 的结果）。 */
export interface DebugException {
  id: string | null;
  description: string | null;
  message: string | null;
}

/** 监视条数上限：再多就盖住变量区，而且 IDE 里也没人挂几十条。 */
export const MAX_DEBUG_WATCHES = 12;

/** 控制台保留的行数上限：足够回溯一次会话，又不会无限吃内存。 */
export const MAX_DEBUG_CONSOLE = 200;

/** 单个目标的暂停现场。面板一次只展示一个目标，另一个在后台保留。 */
interface TargetState {
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
  busy: DebugBusy;
  error: string | null;
  /** 停下的原因（breakpoint / step / pause / exception …）。 */
  stopReason: string | null;
  /** 适配器给的一句话（异常时通常是完整栈文本）。 */
  stopText: string | null;
  /** 异常停靠时补拉的详情。 */
  exception: DebugException | null;
  /** 控制台历史（跨暂停保留，断开时清空）。 */
  console: DebugConsoleEntry[];
}

/** 面板页签与底部小灯要的目标摘要。 */
export interface DebugTargetInfo {
  state: DebugState;
  paused: boolean;
  busy: DebugBusy;
}

export interface DebugSnapshot extends TargetState {
  /** 面板当前展示的目标。 */
  target: DebugTarget;
  /** 监视表达式：跨目标共享，切换目标后按新目标的栈帧重算。 */
  watches: DebugWatch[];
  targets: Record<DebugTarget, DebugTargetInfo>;
  anyPaused: boolean;
  /** 当前启用的异常断点过滤器 id（跨目标共享）。 */
  enabledFilters: string[];
}

const EXCEPTION_FILTER_KEY = "ncforge-debug-exception-filters";

function readEnabledFilters(): string[] {
  try {
    const raw = localStorage.getItem(EXCEPTION_FILTER_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((f): f is string => typeof f === "string")
      : [];
  } catch {
    return [];
  }
}

let enabledFilters = readEnabledFilters();

function persistEnabledFilters(): void {
  try {
    localStorage.setItem(EXCEPTION_FILTER_KEY, JSON.stringify(enabledFilters));
  } catch {
    // 隐私模式：本次会话内仍生效
  }
}

const stoppedStatus = (target: DebugTarget): DebugStatus => ({
  target,
  state: "stopped",
  module: null,
  dapPort: null,
  jdwpPort: null,
  jdwpHost: null,
  message: "",
  exceptionFilters: [],
});

const emptyTarget = (target: DebugTarget): TargetState => ({
  status: stoppedStatus(target),
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
  stopReason: null,
  stopText: null,
  exception: null,
  console: [],
});

const states: Record<DebugTarget, TargetState> = {
  server: emptyTarget("server"),
  client: emptyTarget("client"),
  remote: emptyTarget("remote"),
};
let active: DebugTarget = "server";
let watches: DebugWatch[] = [];

const listeners = new Set<() => void>();

function rebuild(): DebugSnapshot {
  const st = states[active];
  return {
    ...st,
    target: active,
    watches,
    targets: {
      server: { state: states.server.status.state, paused: states.server.paused, busy: states.server.busy },
      client: { state: states.client.status.state, paused: states.client.paused, busy: states.client.busy },
      remote: { state: states.remote.status.state, paused: states.remote.paused, busy: states.remote.busy },
    },
    anyPaused: states.server.paused || states.client.paused || states.remote.paused,
    enabledFilters,
  };
}

let snap: DebugSnapshot = rebuild();

function commit(): void {
  snap = rebuild();
  listeners.forEach((l) => l());
}

/** 改当前目标的现场（面板里的按钮与选择都走这里）。 */
function set(patch: Partial<TargetState & { watches: DebugWatch[] }>): void {
  const { watches: nextWatches, ...rest } = patch;
  if (nextWatches !== undefined) watches = nextWatches;
  states[active] = { ...states[active], ...rest };
  commit();
}

/** 改任意目标的现场；事件可能来自用户正在看的另一边。 */
function setFor(target: DebugTarget, patch: Partial<TargetState>): void {
  states[target] = { ...states[target], ...patch };
  commit();
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

const idleFields = (): Partial<TargetState> => ({
  paused: false,
  threadId: null,
  threads: [],
  frames: [],
  frameId: null,
  scopes: [],
  variables: {},
  stopReason: null,
  stopText: null,
  exception: null,
});

/** 继续/断开后旧帧已经不存在：结果作废，但表达式留着，下次停住再算。 */
function clearWatchResults(): void {
  watches = watches.map((w) => ({ ...w, result: null, type: null, error: null, evaluating: false }));
}

// ── 事件 → 快照 ────────────────────────────────────────────────────────────
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

async function loadStack(target: DebugTarget, threadId: number, seq: number): Promise<void> {
  try {
    const r = await debugStackTrace(target, threadId);
    const st = states[target];
    if (st.stopSeq !== seq || !st.paused) return;
    const frames = r.stackFrames ?? [];
    setFor(target, { frames });
    const first = frames.find((f) => f.id > 0);
    if (first) void selectFrameFor(target, first.id);
  } catch (e) {
    if (states[target].stopSeq === seq) setFor(target, { error: errText(e) });
  }
}

async function selectFrameFor(target: DebugTarget, frameId: number): Promise<void> {
  setFor(target, { frameId, scopes: [], variables: {} });
  try {
    const scopes = (await debugScopes(target, frameId)).scopes ?? [];
    if (states[target].frameId !== frameId) return;
    setFor(target, { scopes });
    const entries = await Promise.all(
      scopes.map(async (s) => {
        try {
          return [s.variablesReference, (await debugVariables(target, s.variablesReference)).variables ?? []] as const;
        } catch {
          return [s.variablesReference, []] as const;
        }
      }),
    );
    if (states[target].frameId !== frameId) return;
    setFor(target, { variables: Object.fromEntries(entries) as Record<number, DapVariable[]> });
    refreshWatches(target, frameId);
  } catch (e) {
    if (states[target].frameId === frameId) setFor(target, { error: errText(e) });
  }
}

export async function selectFrame(frameId: number): Promise<void> {
  return selectFrameFor(active, frameId);
}

/** 每次分页取多少条：够一屏，又不至于把上万元素的集合一次搬过桥。 */
export const DEBUG_VARIABLE_PAGE = 100;

/**
 * 展开一个复合变量（变量树按需拉，别在暂停那一拍把整棵树全取回来）。
 *
 * `start` 用于集合分页：不带 start 是首次展开；带上就是「加载更多」，
 * 结果按顺序追加。同一个引用已经有数据时首次展开直接返回（幂等）。
 */
export async function expandVariables(ref: number, start?: number): Promise<void> {
  const target = active;
  if (ref <= 0) return;
  const existing = states[target].variables[ref];
  if (!start && existing) return;
  try {
    const offset = start ?? 0;
    const vars = (await debugVariables(target, ref, offset, DEBUG_VARIABLE_PAGE)).variables ?? [];
    const cur = states[target].variables[ref] ?? [];
    // 「加载更多」可能与另一页请求交错（连点两次）：按变量名去重后追加。
    // 用名字而不是 references：改写值后适配器可能给同一条目换引用，那不该变成两行。
    const merged = [...cur];
    const seen = new Set(merged.map((v) => v.name));
    for (const v of vars) {
      if (seen.has(v.name)) continue;
      seen.add(v.name);
      merged.push(v);
    }
    setFor(target, { variables: { ...states[target].variables, [ref]: merged } });
  } catch (e) {
    setFor(target, { error: errText(e) });
  }
}

/** 暂停时改写一个变量（DAP `setVariable`）。只改 JVM 现场，不改源码。 */
export async function setVariableValue(ref: number, name: string, value: string): Promise<void> {
  const target = active;
  const st = states[target];
  if (!st.paused || ref <= 0) return;
  try {
    const result = await debugSetVariable(target, ref, name, value);
    const list = states[target].variables[ref] ?? [];
    setFor(target, {
      variables: {
        ...states[target].variables,
        [ref]: list.map((v) =>
          v.name === name
            ? {
                ...v,
                value: typeof result.value === "string" ? result.value : v.value,
                type: typeof result.type === "string" ? result.type : v.type,
                variablesReference:
                  typeof result.variablesReference === "number"
                    ? result.variablesReference
                    : v.variablesReference,
              }
            : v,
        ),
      },
      error: null,
    });
    // 变量变了，监视表达式里的关联值也要跟着变
    if (states[target].frameId) refreshWatches(target, states[target].frameId!);
  } catch (e) {
    setFor(target, { error: errText(e) });
    throw e;
  }
}

// ── 监视表达式 ─────────────────────────────────────────────────────────────
/** 求值回复 → 面板要的 { result, type }。非字符串的 result（少见）序列化后显示。 */
function formatResult(body: Record<string, unknown>): { result: string; type: string | null } {
  const raw = body.result;
  const result = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
  return { result, type: typeof body.type === "string" ? body.type : null };
}

async function evaluateWatch(target: DebugTarget, frameId: number, expression: string): Promise<void> {
  const apply = (patch: Partial<DebugWatch>): void => {
    // 求值是异步的：切走目标、帧切走或已经继续运行时这次结果作废，
    // 否则会把旧帧的值贴到新上下文上，看起来像「当前帧算出来是这个」。
    const st = states[target];
    if (target !== active || st.frameId !== frameId || !st.paused) return;
    watches = watches.map((w) => (w.expression === expression ? { ...w, ...patch } : w));
    commit();
  };
  apply({ evaluating: true, error: null });
  try {
    const body = await debugEvaluate(target, expression, frameId, "watch");
    apply({ evaluating: false, ...formatResult(body) });
  } catch (e) {
    apply({ evaluating: false, result: null, error: errText(e) });
  }
}

/** 每次停住/切换栈帧都把全部监视重算一遍（DAP 的求值上下文跟着 frame 走）。 */
function refreshWatches(target: DebugTarget, frameId: number): void {
  const st = states[target];
  if (!st.paused || st.frameId !== frameId || watches.length === 0) return;
  for (const w of watches) void evaluateWatch(target, frameId, w.expression);
}

export async function addWatch(expression: string): Promise<void> {
  const expr = expression.trim();
  if (!expr || watches.some((w) => w.expression === expr)) return;
  if (watches.length >= MAX_DEBUG_WATCHES) return;
  watches = [...watches, { expression: expr, result: null, type: null, error: null, evaluating: false }];
  commit();
  const st = states[active];
  if (st.paused && st.frameId) await evaluateWatch(active, st.frameId, expr);
}

export function removeWatch(expression: string): void {
  if (!watches.some((w) => w.expression === expression)) return;
  watches = watches.filter((w) => w.expression !== expression);
  commit();
}

// ── 调试控制台（REPL） ─────────────────────────────────────────────────────
let consoleSeq = 0;

/** 在控制台求值。暂停时才有上下文（DAP 的 evaluate 需要当前帧）。 */
export async function evaluateConsole(expression: string): Promise<void> {
  const expr = expression.trim();
  if (!expr) return;
  const target = active;
  const st = states[target];
  if (!st.paused || !st.frameId) return;
  const frameId = st.frameId;
  const id = ++consoleSeq;
  const entry: DebugConsoleEntry = { id, expression: expr, result: null, type: null, error: null, pending: true };
  const push = (patch: Partial<DebugConsoleEntry>): void => {
    const list = states[target].console;
    states[target] = {
      ...states[target],
      console: list.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    };
    commit();
  };
  setFor(target, { console: [...states[target].console, entry].slice(-MAX_DEBUG_CONSOLE) });
  try {
    const body = await debugEvaluate(target, expr, frameId, "repl");
    const cur = states[target];
    if (cur.frameId !== frameId || !cur.paused) {
      push({ pending: false, error: "上下文已变化，结果作废" });
      return;
    }
    push({ pending: false, ...formatResult(body) });
  } catch (e) {
    push({ pending: false, error: errText(e) });
  }
}

export function clearConsole(): void {
  setFor(active, { console: [] });
}

// ── 悬停求值 ───────────────────────────────────────────────────────────────
/** 悬停求值缓存：光标在同一个词上来回移时不该反复打适配器。帧 id 变了键自然失效。 */
const hoverCache = new Map<string, { result: string; type: string | null; error: string | null }>();
const HOVER_CACHE_MAX = 300;

/**
 * 求值一个悬停表达式。未暂停时返回 null（让其它 hover provider 正常显示）。
 * 失败把错误文本带回去，由 UI 决定是否显示——悬停失败不该弹全局错误条。
 */
export async function evaluateHover(
  expression: string,
): Promise<{ result: string; type: string | null; error: string | null } | null> {
  const target = active;
  const st = states[target];
  if (!st.paused || !st.frameId || !expression.trim()) return null;
  const key = `${target}:${st.frameId}:${expression}`;
  const cached = hoverCache.get(key);
  if (cached) return cached;
  try {
    const body = await debugEvaluate(target, expression, st.frameId, "hover");
    const hit = { ...formatResult(body), error: null };
    hoverCache.set(key, hit);
    if (hoverCache.size > HOVER_CACHE_MAX) {
      const oldest = hoverCache.keys().next().value;
      if (oldest !== undefined) hoverCache.delete(oldest);
    }
    return hit;
  } catch (e) {
    const miss = { result: "", type: null, error: errText(e) };
    hoverCache.set(key, miss);
    return miss;
  }
}

// ── 线程与异常 ─────────────────────────────────────────────────────────────
/** 切换当前线程并重新取栈（面板的线程列表）。 */
export async function selectThread(threadId: number): Promise<void> {
  const target = active;
  const st = states[target];
  if (!st.paused || threadId <= 0 || threadId === st.threadId) return;
  setFor(target, { threadId, frames: [], frameId: null, scopes: [], variables: {} });
  await loadStack(target, threadId, st.stopSeq);
}

/** 手动刷新线程列表（JVM 线程随时在增删，事件不保证覆盖）。 */
export async function refreshThreadsNow(): Promise<void> {
  await refreshThreads(active);
}

async function loadExceptionInfo(target: DebugTarget, threadId: number, seq: number): Promise<void> {
  try {
    const info = await debugExceptionInfo(target, threadId);
    const st = states[target];
    if (st.stopSeq !== seq || !st.paused) return;
    setFor(target, {
      exception: {
        id: typeof info.exceptionId === "string" ? info.exceptionId : null,
        description: typeof info.description === "string" ? info.description : null,
        message: typeof info.details?.message === "string" ? info.details.message : null,
      },
    });
  } catch {
    // 适配器不支持 exceptionInfo 时保留 stopped 事件里的 text
  }
}

// ── 异常断点过滤器 ─────────────────────────────────────────────────────────
/** 把当前启用的过滤器下发给某个已附加的目标。 */
async function applyExceptionFilters(target: DebugTarget): Promise<void> {
  if (states[target].status.state !== "attached") return;
  try {
    await debugSetExceptionBreakpoints(target, enabledFilters);
  } catch {
    // 适配器不支持时不影响普通断点调试，用户主动切换时再报错
  }
}

/** 开/关一个异常断点过滤器（立即对两个已附加目标生效并落盘）。 */
export async function setExceptionFilter(filter: string, on: boolean): Promise<void> {
  const next = on
    ? Array.from(new Set([...enabledFilters, filter]))
    : enabledFilters.filter((f) => f !== filter);
  if (next.length === enabledFilters.length && next.every((f) => enabledFilters.includes(f))) return;
  enabledFilters = next;
  persistEnabledFilters();
  commit();
  const failures: string[] = [];
  await Promise.all(
    DEBUG_TARGETS.filter((t) => states[t].status.state === "attached").map(async (t) => {
      try {
        await debugSetExceptionBreakpoints(t, enabledFilters);
      } catch (e) {
        failures.push(`${debugTargetLabel(t)}：${errText(e)}`);
      }
    }),
  );
  if (failures.length > 0) setFor(active, { error: failures.join("；") });
}

async function refreshThreads(target: DebugTarget): Promise<void> {
  if (states[target].status.state !== "attached") return;
  try {
    const list = (await debugThreads(target)).threads ?? [];
    if (states[target].status.state === "attached") setFor(target, { threads: list });
  } catch {
    // 线程列表只服务「暂停」按钮；拿不到就把按钮留着禁用态
  }
}

/** 每个目标各自计数：另一边的事件不该让这边的失败恢复失效。 */
const revisions: Record<DebugTarget, number> = { server: 0, client: 0, remote: 0 };

function targetOf(raw: unknown): DebugTarget {
  return raw === "client" || raw === "remote" ? raw : "server";
}

function onEvent(e: DebugEvent): void {
  const target = targetOf(e.target);
  if (["stopped", "continued", "terminated"].includes(e.event)) revisions[target]++;
  const body = e.body ?? {};
  switch (e.event) {
    case "stopped": {
      const threadId = num(body.threadId);
      const seq = states[target].stopSeq + 1;
      prepareDebugSourceNavigation(target, seq);
      const reason = typeof body.reason === "string" ? body.reason : null;
      const text =
        typeof body.text === "string"
          ? body.text
          : typeof body.description === "string"
            ? body.description
            : null;
      setFor(target, {
        ...idleFields(),
        paused: true,
        threadId,
        stopSeq: seq,
        error: null,
        stopReason: reason,
        stopText: text,
      });
      // 哪一边断住了就切到哪一边：两边可以同时暂停，不能停在另一边的旧栈上
      if (target !== active) selectDebugTarget(target);
      clearWatchResults();
      commit();
      // Stopping clears the old stack and threads; request the new list even without a thread event.
      void refreshThreads(target);
      if (threadId) {
        void loadStack(target, threadId, seq);
        // 异常停靠：stopped 事件只有一句话，类型和消息要再问适配器
        if (reason === "exception") void loadExceptionInfo(target, threadId, seq);
      }
      // The pause indicator still updates while a locked layout keeps the user's current tool.
      if (!getWorkbenchLayout().locked) setSession({ panelOpen: true, panelTab: "debug" });
      break;
    }
    case "continued":
    case "terminated":
      setFor(target, idleFields());
      // 另一边继续运行不该把这一边的监视结果清掉
      if (target === active) {
        clearWatchResults();
        commit();
      }
      break;
    case "breakpoint": {
      const b = body.breakpoint as { verified?: boolean; line?: number; source?: { path?: string } } | undefined;
      if (b?.source?.path && typeof b.line === "number") {
        applyBreakpointEvent(target, b.source.path, b.line, !!b.verified);
      }
      break;
    }
    case "thread":
      void refreshThreads(target);
      break;
    default:
      break;
  }
}

let listening = false;

function applyStatus(s: DebugStatus): void {
  const target = targetOf(s.target);
  const wasAttached = states[target].status.state === "attached";
  const nowAttached = s.state === "attached";
  setFor(target, { status: s, ...(nowAttached ? {} : idleFields()) });
  if (nowAttached && !wasAttached) {
    void syncBreakpoints();
    void refreshThreads(target);
    // 异常断点属于「会话偏好」：每次附加都要重新告诉适配器
    void applyExceptionFilters(target);
  }
  if (!nowAttached && wasAttached) {
    resetBreakpointSync(target);
    // 另一个目标还挂着就保留监视表达式；两边都断了才清。清结果也只清正在看的这一边。
    if (DEBUG_TARGETS.every((t) => states[t].status.state !== "attached")) watches = [];
    else if (target === active) clearWatchResults();
    // 会话结束后控制台历史没有上下文了（IDEA 同样清空控制台）
    setFor(target, { console: [] });
    commit();
  }
}

function ensureListeners(): void {
  if (listening) return;
  listening = true;
  // 非 Tauri 环境（单测 / 浏览器预览）没有事件桥：订阅失败不该冒成未处理拒绝
  void onDebugStatus(applyStatus).catch(() => {});
  void onDebugEvent(onEvent).catch(() => {});
  // 窗口重开/页面重挂时补一次真实状态：事件只覆盖变化，不覆盖「本来就是这样」
  for (const target of DEBUG_TARGETS) {
    void debugStatus(target)
      .then((s) => {
        const local = states[target].status.state;
        if (s.state === "attached" && local !== "attached") applyStatus(s);
        else if (s.state !== "attached" && local === "attached") applyStatus(s);
      })
      .catch(() => {
        // 后端不可用时保持 stopped：界面仍有「附加调试器」入口
      });
  }
  startBreakpointSync(() => DEBUG_TARGETS.filter((t) => states[t].status.state === "attached"));
}

export function useDebugSnapshot(): DebugSnapshot {
  const value = useSyncExternalStore(subscribe, getDebugSnapshot, getDebugSnapshot);
  useEffect(() => {
    ensureListeners();
  }, []);
  return value;
}

/** 切换面板正在看的目标。另一个目标的暂停现场原样保留。 */
export function selectDebugTarget(target: DebugTarget): void {
  if (target === active) return;
  active = target;
  clearWatchResults();
  commit();
  const st = states[target];
  if (st.paused && st.frameId) refreshWatches(target, st.frameId);
}

// ── 动作 ───────────────────────────────────────────────────────────────────
export async function attachDebugger(
  target: DebugTarget = active,
  endpoint?: RemoteEndpoint,
): Promise<void> {
  const st = states[target];
  if (st.status.state === "attached" || st.busy) return;
  if (target !== active) selectDebugTarget(target);
  setFor(target, { busy: "attach", error: null });
  try {
    const status = await debugStart(target, endpoint);
    setFor(target, { status, busy: null });
    if (status.state === "attached") {
      void syncBreakpoints();
      void refreshThreads(target);
      void applyExceptionFilters(target);
    }
  } catch (e) {
    setFor(target, { busy: null, error: errText(e) });
    throw e;
  }
}

export async function detachDebugger(target: DebugTarget = active): Promise<void> {
  const st = states[target];
  if (st.status.state !== "attached" || st.busy) return;
  setFor(target, { busy: "detach", error: null });
  try {
    await debugStop(target);
    setFor(target, { status: stoppedStatus(target), ...idleFields(), busy: null, console: [] });
    resetBreakpointSync(target);
    if (DEBUG_TARGETS.every((t) => states[t].status.state !== "attached")) watches = [];
    else if (target === active) clearWatchResults();
    commit();
  } catch (e) {
    setFor(target, { busy: null, error: errText(e) });
    throw e;
  }
}

export async function resumeDebug(target: DebugTarget = active): Promise<void> {
  const previous = states[target];
  const revision = revisions[target];
  const threadId = previous.threadId;
  if (!previous.paused || !threadId) return;
  setFor(target, idleFields());
  clearWatchResults();
  commit();
  try {
    await debugContinue(target, threadId);
  } catch (e) {
    // 请求失败且没有新的调试事件时恢复暂停位置，保留可重试的按钮和上下文。
    const cur = states[target];
    if (revisions[target] === revision && cur.stopSeq === previous.stopSeq && cur.status.state === "attached") {
      states[target] = { ...previous, error: errText(e) };
      commit();
    } else setFor(target, { error: errText(e) });
  }
}

export async function stepDebug(kind: Exclude<DebugAction, "resume">, target: DebugTarget = active): Promise<void> {
  const previous = states[target];
  const revision = revisions[target];
  const threadId = previous.threadId;
  if (!previous.paused || !threadId) return;
  // 先松开 paused：步过要等下一次 stopped 事件，界面不能在这期间一直显示「已暂停」
  setFor(target, idleFields());
  clearWatchResults();
  commit();
  try {
    await debugStep(target, threadId, kind);
  } catch (e) {
    // 请求失败且没有新的调试事件时恢复暂停位置，保留可重试的按钮和上下文。
    const cur = states[target];
    if (revisions[target] === revision && cur.stopSeq === previous.stopSeq && cur.status.state === "attached") {
      states[target] = { ...previous, error: errText(e) };
      commit();
    } else setFor(target, { error: errText(e) });
  }
}

export async function pauseDebug(target: DebugTarget = active): Promise<void> {
  const st = states[target];
  const threadId = st.threadId ?? st.threads.find((t) => t.id > 0)?.id ?? null;
  if (!threadId) return;
  try {
    await debugPause(target, threadId);
  } catch (e) {
    setFor(target, { error: errText(e) });
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
