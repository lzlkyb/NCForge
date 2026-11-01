import { invoke, listen } from "./tauri";

/**
 * 调试（DAP）前端接口。与 Rust `commands/debug_cmds.rs` 一一对应。
 *
 * 路径约定：进出都是**真实文件路径**（Java 栈帧的 `source.path` 已由后端换回），
 * 影子工程路径只存在于 Rust 内部。
 */

export type DebugState = "stopped" | "attached";

export interface DebugStatus {
  state: DebugState;
  module: string | null;
  /** java-debug 的 DAP 端口。 */
  dapPort: number | null;
  /** 中间件 JVM 的 JDWP 端口。 */
  jdwpPort: number | null;
  /** 最近一次断开/失败的原因（正常停止时为空）。 */
  message: string;
}

export interface DebugEvent {
  event: string;
  body: Record<string, unknown> | null;
}

export interface DapSource {
  path?: string;
  name?: string;
}

export interface DapBreakpoint {
  id?: number;
  verified: boolean;
  line?: number;
  message?: string;
  source?: DapSource;
}

export interface DapThread {
  id: number;
  name: string;
}

export interface DapStackFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: DapSource;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  /** 变量很多时后端按需展开，这里只用来决定能不能点开。 */
  expensive: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export const debugStatus = () => invoke<DebugStatus>("debug_status");
/** 建立会话（要求服务以调试模式启动、代码智能已就绪）。 */
export const debugStart = () => invoke<DebugStatus>("debug_start");
export const debugStop = () => invoke<void>("debug_stop");

/** `lines` 为空 = 清空该文件所有断点。返回每个断点的 verified 状态。 */
export const debugSetBreakpoints = (path: string, lines: number[]) =>
  invoke<{ breakpoints?: DapBreakpoint[] }>("debug_set_breakpoints", { path, lines });

export const debugContinue = (threadId: number) =>
  invoke<Record<string, unknown>>("debug_continue", { threadId });
export const debugStep = (threadId: number, kind: "over" | "into" | "out") =>
  invoke<Record<string, unknown>>("debug_step", { threadId, kind });
export const debugPause = (threadId: number) =>
  invoke<Record<string, unknown>>("debug_pause", { threadId });
export const debugThreads = () =>
  invoke<{ threads?: DapThread[] }>("debug_threads");
export const debugStackTrace = (threadId: number) =>
  invoke<{ stackFrames?: DapStackFrame[] }>("debug_stack_trace", { threadId });
export const debugScopes = (frameId: number) =>
  invoke<{ scopes?: DapScope[] }>("debug_scopes", { frameId });
export const debugVariables = (variablesReference: number) =>
  invoke<{ variables?: DapVariable[] }>("debug_variables", { variablesReference });
export const debugEvaluate = (expression: string, frameId?: number) =>
  invoke<Record<string, unknown>>("debug_evaluate", { expression, frameId });

export const onDebugStatus = (handler: (s: DebugStatus) => void) =>
  listen<DebugStatus>("debug-status", handler);
export const onDebugEvent = (handler: (e: DebugEvent) => void) =>
  listen<DebugEvent>("debug-event", handler);
