import { invoke } from "./tauri";
import { trackOperation } from "./operations";
import { markServiceStopping, startServiceOperation } from "./serviceStartup";
import type { LaunchPreview, LogChunk, LogClearResult, ServerState, StopOutcome } from "./server";

/**
 * NC 客户端（Swing `nc.starter.test.JStarter`）的 IPC 层。
 *
 * 与中间件的结构刻意保持同形（`ServerStatus` / `LaunchPreview` 的字段一一对应），
 * 这样日志面板、命令行弹窗、堆上限输入框都能直接复用；差异只有三处：
 * 没有监听端口（只有「要连的中间件地址」）、classpath 规则不同、状态里多了
 * `serverReachable` 用来提示「客户端起来了但中间件还没就绪」。
 */

export interface ClientStatus {
  state: ServerState;
  runId?: string | null;
  launchPhase?: string | null;
  launchStartedAtMs?: number | null;
  pid: number | null;
  startedAtMs: number | null;
  uptimeMs: number | null;
  /** 客户端连接中间件用的地址（`-Dnc.jstart.server`）。 */
  host: string;
  /** 客户端连接中间件用的端口（读自 `ierp/bin/prop.xml`）。 */
  port: number;
  /** 该端口当前是否可连；false 时客户端能开窗口但登录会失败。 */
  serverReachable: boolean;
  logPath: string;
  logSize: number;
  java: string | null;
  /** 上次启动装进 classpath 的条目数（Eclipse 客户端规则，约 4700 项）。 */
  classpathEntries: number;
  mainClass: string;
  commandLine: string;
  exitCode: number | null;
  reason: string | null;
  projectRoot: string | null;
  ncHome: string | null;
  heapMb: number;
  defaultHeapMb: number;
  debugPort: number | null;
}

/** 客户端命令行预览，形状与 `LaunchPreview` 相同，直接复用同一个弹窗。 */
export type ClientPreview = LaunchPreview;

export const clientStatus = () => invoke<ClientStatus>("client_status");

/**
 * 启动客户端。`debug` 为 true 时给 JVM 加 JDWP（只绑 127.0.0.1，端口由系统分配）。
 *
 * 判成功的标准与中间件不同：客户端没有监听端口，进程活着就算启动成功；
 * 窗口出现还要几秒，所以文案说「进程已启动」而不是「界面已就绪」。
 */
export function clientStart(debug = false, options?: { requestId?: string }): Promise<string> {
  return startServiceOperation({ target: "client", debug, requestId: options?.requestId,
    request: requestId => invoke<string>("client_start", { debug, requestId }),
    status: clientStatus, stop: expectedRunId => invoke<StopOutcome>("client_stop", { expectedRunId }) });
}

export const clientStop = (expectedRunId?: string) =>
  trackOperation(
    { key: `client.stop${expectedRunId ? ':' + expectedRunId : ''}`, label: "停止客户端", scope: "NC 客户端", page: "files", panel: "svc" },
    async () => {
      const outcome = await invoke<StopOutcome>("client_stop", { expectedRunId: expectedRunId ?? null });
      markServiceStopping("client", expectedRunId, outcome);
      return outcome;
    },
    (outcome) => ({
      state: "success",
      detail:
        outcome === "cancelling"
          ? "停止请求已发送，启动流程仍在退出"
          : outcome === "idle"
            ? "客户端没有在运行"
            : "客户端已停止",
    }),
  );

export const clientLog = (offset: number) => invoke<LogChunk>("client_log", { offset });

export const clientClearLog = () =>
  trackOperation(
    { key: "client.log.clear", label: "清理客户端日志", scope: "NC 客户端", page: "files", panel: "svc" },
    () => invoke<LogClearResult>("client_clear_log"),
  );

export const clientCommandLine = () =>
  trackOperation(
    { key: "client.command", label: "生成客户端命令行", scope: "NC 客户端", page: "files", panel: "svc" },
    () => invoke<ClientPreview>("client_command_line"),
  );

export const clientRevealLog = (previous = false) => invoke<void>("client_reveal_log", { previous });

/** 改客户端堆上限（MB），传 null 恢复默认 768。返回后端收口后的生效值。 */
export const clientHeapSet = (heapMb: number | null) =>
  trackOperation(
    { key: "client.heap", label: "保存客户端内存设置", scope: "NC 客户端", page: "files", panel: "svc" },
    () => invoke<number>("client_heap_set", { heapMb }),
  );
