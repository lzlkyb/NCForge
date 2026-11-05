import { invoke, listen } from "./tauri";
import { trackOperation } from "./operations";

/**
 * 调试（DAP）前端接口。与 Rust `commands/debug_cmds.rs` 一一对应。
 *
 * 路径约定：进出都是**真实文件路径**（Java 栈帧的 `source.path` 已由后端换回），
 * 影子工程路径只存在于 Rust 内部。
 */

export type DebugState = "stopped" | "attached";

/** 三个调试槽：中间件、客户端，以及用户手工填地址的远程 JVM。 */
export type DebugTarget = "server" | "client" | "remote";
export const DEBUG_TARGETS: readonly DebugTarget[] = ["server", "client", "remote"];
export const debugTargetLabel = (target: DebugTarget): string =>
  target === "client" ? "客户端" : target === "remote" ? "远程" : "中间件";

/** 远程附加地址：端口通常是 `ssh -L` 映射到本机的那个端口。 */
export interface RemoteEndpoint {
  host: string;
  port: number;
}

export interface DebugStatus {
  target: DebugTarget;
  state: DebugState;
  module: string | null;
  /** java-debug 的 DAP 端口。 */
  dapPort: number | null;
  /** 被调试 JVM 的 JDWP 端口。 */
  jdwpPort: number | null;
  /** 被调试 JVM 的 JDWP 主机（本机是 127.0.0.1；远程是用户填的地址）。 */
  jdwpHost: string | null;
  /** 最近一次断开/失败的原因（正常停止时为空）。 */
  message: string;
  /** 适配器支持的异常断点过滤器（未附加时为空）。 */
  exceptionFilters: ExceptionFilter[];
}

/** 适配器能力：异常断点的一个过滤器（java-debug 当前是 caught / uncaught）。 */
export interface ExceptionFilter {
  filter: string;
  label: string;
  default: boolean;
}

/** 一条断点的完整规格（启用状态由前端决定，禁用时不会下发）。 */
export interface BreakpointSpec {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface DebugEvent {
  target: DebugTarget;
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
  /** 集合类变量的总数：大于已取到的条目数时，变量树给「加载更多」。 */
  indexedVariables?: number;
  namedVariables?: number;
}

export const debugStatus = (target: DebugTarget = "server") =>
  invoke<DebugStatus>("debug_status", { target });
/** 建立会话（要求目标以调试模式启动、代码智能已就绪）。远程目标额外带地址。 */
export const debugStart = (target: DebugTarget = "server", endpoint?: RemoteEndpoint) =>
  trackOperation(
    { key: `debug.attach:${target}`, label: `附加调试器（${debugTargetLabel(target)}）`, scope: `NC ${debugTargetLabel(target)}`, page: "files", panel: "debug", phase: "连接调试适配器与 JVM" },
    async () => {
      const result = await invoke<DebugStatus>("debug_start", {
        target,
        // 显式传 null：invoke 序列化会丢掉 undefined 键，缺键在 Rust 侧不是「空」而是参数错误。
        host: endpoint?.host ?? null,
        port: endpoint?.port ?? null,
      });
      if (result.state !== "attached") throw new Error(result.message || "尚未建立调试会话");
      return result;
    },
    (result) => ({ state: result.state === "attached" ? "success" : "failed", detail: result.message || (result.state === "attached" ? "调试会话已建立" : "尚未建立调试会话") }),
  );
export const debugStop = (target: DebugTarget = "server") =>
  trackOperation({ key: `debug.detach:${target}`, label: `断开调试器（${debugTargetLabel(target)}）`, scope: `NC ${debugTargetLabel(target)}`, page: "files", panel: "debug" }, () => invoke<void>("debug_stop", { target }));

/** `breakpoints` 为空 = 清空该文件所有断点。返回每个断点的 verified 状态。 */
export const debugSetBreakpoints = (target: DebugTarget, path: string, breakpoints: BreakpointSpec[]) =>
  invoke<{ breakpoints?: DapBreakpoint[] }>("debug_set_breakpoints", { target, path, breakpoints });

/** 异常断点过滤器（空数组 = 全部关闭）。 */
export const debugSetExceptionBreakpoints = (target: DebugTarget, filters: string[]) =>
  invoke<Record<string, unknown>>("debug_set_exception_breakpoints", { target, filters });

export const debugContinue = (target: DebugTarget, threadId: number) =>
  trackOperation({ key: `debug.control:${target}:${threadId}`, label: "继续调试运行", page: "files", panel: "debug" }, () => invoke<Record<string, unknown>>("debug_continue", { target, threadId }), () => ({ state: "success", detail: "继续请求已返回，后续状态由调试事件确认" }));
export const debugStep = (target: DebugTarget, threadId: number, kind: "over" | "into" | "out") =>
  trackOperation({ key: `debug.control:${target}:${threadId}`, label: kind === "over" ? "调试步过" : kind === "into" ? "调试步入" : "调试步出", page: "files", panel: "debug" }, () => invoke<Record<string, unknown>>("debug_step", { target, threadId, kind }), () => ({ state: "success", detail: "步进请求已返回，等待下一次暂停事件" }));
export const debugPause = (target: DebugTarget, threadId: number) =>
  trackOperation({ key: `debug.pause:${target}:${threadId}`, label: "请求调试暂停", page: "files", panel: "debug" }, () => invoke<Record<string, unknown>>("debug_pause", { target, threadId }), () => ({ state: "success", detail: "暂停请求已返回，暂停位置由调试事件确认" }));
export const debugThreads = (target: DebugTarget) =>
  invoke<{ threads?: DapThread[] }>("debug_threads", { target });
export const debugStackTrace = (target: DebugTarget, threadId: number) =>
  invoke<{ stackFrames?: DapStackFrame[] }>("debug_stack_trace", { target, threadId });
export const debugScopes = (target: DebugTarget, frameId: number) =>
  invoke<{ scopes?: DapScope[] }>("debug_scopes", { target, frameId });
export const debugVariables = (
  target: DebugTarget,
  variablesReference: number,
  start?: number,
  count?: number,
) =>
  invoke<{ variables?: DapVariable[] }>("debug_variables", { target, variablesReference, start, count });
export const debugSetVariable = (
  target: DebugTarget,
  variablesReference: number,
  name: string,
  value: string,
) =>
  invoke<Partial<DapVariable>>("debug_set_variable", { target, variablesReference, name, value });
export const debugExceptionInfo = (target: DebugTarget, threadId: number) =>
  invoke<{
    exceptionId?: string;
    description?: string;
    details?: { message?: string; typeName?: string; stackTrace?: string };
  }>("debug_exception_info", { target, threadId });
export const debugEvaluate = (
  target: DebugTarget,
  expression: string,
  frameId?: number,
  context: "repl" | "watch" | "hover" = "repl",
) => invoke<Record<string, unknown>>("debug_evaluate", { target, expression, frameId, context });

export const onDebugStatus = (handler: (s: DebugStatus) => void) =>
  listen<DebugStatus>("debug-status", handler);
export const onDebugEvent = (handler: (e: DebugEvent) => void) =>
  listen<DebugEvent>("debug-event", handler);
