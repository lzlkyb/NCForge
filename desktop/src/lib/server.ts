import { invoke } from "./tauri";
import { beginOperation, trackOperation } from "./operations";

/** 与 Rust `server_cmds` 的结构一一对应（camelCase；Option 序列化为 null）。 */

export type ServerState = "stopped" | "starting" | "running";

export interface PortOwner {
  pid: number;
  name: string;
}

/**
 * 后端读不到进程名时 `PortOwner.name` 的占位值（Rust `server::UNKNOWN_PROCESS`）。
 *
 * 跨语言没法共享常量，所以这里必须与 Rust 那份保持同一字面量——两处都写了注释
 * 互相指认。用它而不是各组件里手写字符串：一旦后端改文案，只有这里要跟着改。
 */
export const UNKNOWN_PROCESS_NAME = "未知进程";

export interface ServerStatus {
  state: ServerState;
  pid: number | null;
  startedAtMs: number | null;
  uptimeMs: number | null;
  /** 中间件监听端口，读自 `ierp/bin/prop.xml`（不是写死的 80）。 */
  port: number;
  /** 监听地址；`127.0.0.1` 表示只有本机能访问。 */
  portAddress: string | null;
  /** 端口是从配置文件读到的（false = 没读到，按默认 80 显示）。 */
  portFromConfig: boolean;
  /** 端口配置文件路径，界面用来显示「端口从哪来」。 */
  portConfigPath: string;
  portOwner: PortOwner | null;
  /** 占着端口的那个进程是不是本应用起的（false 且 portOwner 非空 = 冲突）。 */
  portOwnedBySelf: boolean;
  logPath: string;
  logSize: number;
  java: string | null;
  /** 上次启动装进 classpath 的条目数（工程 classes + 7000+ 个 jar）。 */
  classpathEntries: number;
  mainClass: string;
  commandLine: string;
  exitCode: number | null;
  reason: string | null;
  projectRoot: string | null;
  ncHome: string | null;
  /** 实际会写进命令行的堆上限（MB，后端已收口到合法范围）。 */
  heapMb: number;
  /** 堆上限的默认值（MB），用来标「默认 4G」。 */
  defaultHeapMb: number;
  /** 本次启动开了 JDWP 调试时的回环端口（未开 = null）。 */
  debugPort: number | null;
}

export interface LogChunk {
  text: string;
  offset: number;
}

/** 中间件监听端点（Rust `nc_home::ServerEndpoints`）。 */
export interface ServerEndpoints {
  httpPort: number;
  httpAddress: string | null;
  servicePort: number | null;
  configPath: string;
  fromConfig: boolean;
}

export interface LaunchPreview {
  commandLine: string;
  classpathJar: string;
  entryCount: number;
  workDir: string;
  java: string;
  endpoints: ServerEndpoints;
  /** 这次会用的堆上限（MB）。 */
  heapMb: number;
  /** classpath 清单是复用上次启动写好的 jar（true）还是这次新算的。 */
  reused: boolean;
}

export interface NcHome {
  root: string;
  java: string;
  moduleCount: number;
  hasNcStarter: boolean;
}

/**
 * 停止结果（Rust `server::StopOutcome`）。
 *
 * 三态而不是 bool：在「启动还在准备（写 pathing jar）」时点停止，既不是停掉了一个进程，
 * 也不是没东西可停——是「已记下，让启动流程自己放弃」。把它说成「已停止」最坑：
 * 服务随后照旧起来，用户以为已经停了。
 */
export type StopOutcome = "stopped" | "cancelling" | "idle";

export const serverStatus = () => invoke<ServerStatus>("server_status");
/**
 * 启动中间件。`debug` 为 true 时后端给 JVM 加 JDWP（只绑 127.0.0.1，端口由系统分配，
 * 启动后从 `ServerStatus.debugPort` 读回）。
 */
let startupStopping = false;
export async function serverStart(debug = false): Promise<void> {
  const task = beginOperation({ key: "service.start", label: debug ? "启动调试服务" : "启动服务", scope: "NC 中间件", page: "files", panel: "svc",
    phase: "准备启动命令", cancel: async () => { await invoke<StopOutcome>("server_stop"); startupStopping = true; } });
  if (!task) throw new Error("服务正在启动，请稍候");
  startupStopping = false;
  try {
    await invoke<void>("server_start", { debug });
    task.update({ phase: "启动请求已接受，等待监听端口" });
    // 启动 IPC 只确认请求；跨页之后也要继续观察真实端口状态才可报启动完成。
    void (async () => {
      try {
        for (;;) {
          const status = await serverStatus();
          if (status.state === "running") { task.finish("success", `监听端口 ${status.port} 已就绪`); return; }
          if (status.state === "stopped") { task.finish(startupStopping ? "cancelled" : "failed", status.reason || "服务在监听端口就绪前已停止，请检查日志"); return; }
          task.update({ phase: startupStopping ? "等待服务停止" : "正在加载模块，等待监听端口" });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) { task.finish("failed", `无法确认启动结果：${String(error)}，请重新读取服务状态`); }
    })();
  } catch (error) { task.finish(String(error).includes("CANCELLED:") ? "cancelled" : "failed", String(error)); throw error; }
}
export const serverStop = () => trackOperation({ key: "service.stop", label: "停止服务", scope: "NC 中间件", page: "files", panel: "svc" },
  async () => { const outcome = await invoke<StopOutcome>("server_stop"); startupStopping = true; return outcome; }, outcome => ({ state: "success", detail: outcome === "cancelling" ? "停止请求已发送，启动流程仍在退出" : outcome === "idle" ? "服务没有在运行" : "服务已停止" }));
export const serverLog = (offset: number) => invoke<LogChunk>("server_log", { offset });

/** 清空日志的结果。运行中清空不动磁盘文件，只把读取偏移快进到当前末尾。 */
export interface LogClearResult {
  offset: number;
  /** true = 旧日志已改名成 .log.1（服务没在跑）；false = 文件没动（服务在跑）。 */
  rotated: boolean;
}
export const serverClearLog = () => trackOperation({ key: "service.log.clear", label: "清理服务日志", scope: "NC 中间件", page: "files", panel: "svc" }, () => invoke<LogClearResult>("server_clear_log"));
export const serverCommandLine = () => trackOperation({ key: "service.command", label: "生成启动命令行", scope: "NC 中间件", page: "files", panel: "svc" }, () => invoke<LaunchPreview>("server_command_line"));
export const serverRevealLog = () => invoke<void>("server_reveal_log");
/** 结束占用中间件端口的 java 进程（端口取自 NC 配置），返回被结束的 PID。 */
export const serverKillPortOwner = () => trackOperation({ key: "service.kill", label: "结束端口占用进程", scope: "NC 中间件", page: "files", panel: "svc" }, () => invoke<number>("server_kill_port_owner"));

/**
 * 改中间件堆上限（MB），传 null 恢复默认 4G。返回后端收口后的生效值。
 *
 * 只写配置、不动正在跑的 JVM（堆是启动参数），所以改完必须重启服务才生效。
 * 越界由后端报错（不在前端夹边），两边只认一份规则。
 */
export const serverHeapSet = (heapMb: number | null) =>
  trackOperation({ key: "service.heap", label: "保存服务内存设置", scope: "NC 中间件", page: "files", panel: "svc" }, () => invoke<number>("server_heap_set", { heapMb }));

/**
 * 堆上限的显示文案：整 G 显示成 `4 GB`，非整数 G 保留 MB（如 `3072 MB` 不写 `3 GB`，
 * 免得用户以为自己填的 3072 被悄悄改成了 3G）。
 */
export function formatHeapMb(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "—";
  return mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}

/** 探测 NC home。`path` 传 null = 用当前配置 / 默认位置。 */
export const ncHomeProbe = (path: string | null = null) => invoke<NcHome>("nc_home_probe", { path });
/** 选择 / 清空（传空串）NC home 并落盘。 */
export const ncHomeSet = (path: string) => trackOperation({ key: "service.home", label: "验证并保存 NC 目录", scope: "NC 中间件", page: "files", panel: "svc" }, () => invoke<NcHome>("nc_home_set", { path }));

/** 改端口时一处要动的配置（Rust `nc_port::PortEdit`）。 */
export interface PortEdit {
  path: string;
  /** 打补丁的目标类型（写入时后端按它分派，不要靠 label 判断）。 */
  kind: "httpPort" | "ejbPort";
  /** 「中间件监听端口」/「web 端连接端口」，**只用于显示**。 */
  label: string;
  /** 文件里的现值；null = 文件不存在或没有这一项。 */
  current: number | null;
  next: number;
  exists: boolean;
  /** 改前的那一行，预览用。 */
  before: string | null;
  /** 改后的那一行，预览用；`null` = 这一项改不了（值不是纯数字），不会被写入。 */
  after: string | null;
}

export interface PortPlan {
  newPort: number;
  currentPort: number;
  edits: PortEdit[];
  /** 本工具改不到、需要用户自己同步的地方。 */
  manual: string[];
  /** 不能执行的原因（服务在跑、端口没变…）。有值时禁用「应用」。 */
  blocked: string | null;
  warnings: string[];
}

export interface PortApplied {
  written: string[];
  backups: string[];
  verifiedPort: number;
  /** 写完重新读配置是否等于目标端口。 */
  verified: boolean;
}

/** 预览改端口方案（只读，不写文件）。 */
export const ncPortPreview = (port: number) => trackOperation({ key: `service.port.preview:${port}`, label: "检查端口修改方案", scope: "NC 中间件", page: "files", panel: "svc" }, () => invoke<PortPlan>("nc_port_preview", { port }));
/** 执行改端口（会写 NC home 的两份配置，并留下 .ncforge-bak 备份）。 */
export const ncPortApply = (port: number) => trackOperation({ key: "service.port.apply", label: "修改监听端口", scope: "NC 中间件", page: "files", panel: "svc" }, () => invoke<PortApplied>("nc_port_apply", { port }), result => ({ state: result.verified ? "success" : "failed", detail: result.verified ? "配置已写入并验证" : "配置已写入，但读取验证不一致，请检查配置与备份" }));
