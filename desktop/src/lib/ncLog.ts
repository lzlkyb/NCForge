import { invoke } from "./tauri";

/**
 * NC 运行日志（`nclogs/`）的接口层。**与 Rust `nc_log_cmds` / `nc_log` 一一对应**
 * （camelCase；`Option` 序列化为 null）。
 *
 * 这里只放类型与取值，不放任何 UI 判断 —— 规则与措辞归后端（`nc_log_rules.rs`），
 * 前端只负责把结论摆出来。两边的字面量（`severity` 的三个值）必须一致。
 */

export interface LogFileInfo {
  logger: string;
  /** 文件名（不含目录），界面显示 `nc-log.log:12` 用。 */
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  /** 轮转出来的旧文件（`.log.1` …），false = 当前正在写的那个。 */
  rotated: boolean;
}

export interface LoggerGroup {
  name: string;
  /** logger 门限。`OFF` 的不产文件 —— 界面据此解释「为什么这个 logger 是空的」。 */
  level: string | null;
  files: LogFileInfo[];
  newestMs: number;
  totalSize: number;
}

export interface SourceInfo {
  home: string;
  /** `ierp/bin/logger-config.properties`（读不到时也给出来，便于排查）。 */
  configPath: string;
  /** 文件名是不是从 logger 配置来的（false = 目录探测兜底）。 */
  fromConfig: boolean;
  /** `${server}` 实际展开成的目录名。 */
  serverDir: string;
  loggers: LoggerGroup[];
  logsRoot: string;
}

export type Severity = "error" | "warn" | "slow";

/** 结论里的跳转动作（Rust `Jump` 的内部标签序列化）。 */
export type Jump =
  | { kind: "table"; table: string }
  | { kind: "source"; class: string }
  | { kind: "upm"; path: string };

export interface Verdict {
  /** 规则 id（同类问题合并计数用）。 */
  rule: string;
  severity: Severity;
  /** 已代入参数的一句话结论。 */
  title: string;
  cause: string;
  action: string;
  jump: Jump | null;
}

export interface LogEntry {
  logger: string;
  file: string;
  lineNo: number;
  ts: string | null;
  /** 就是 traceId（`epoch毫秒-序号`）。 */
  callId: string | null;
  thread: string | null;
  userId: string | null;
  /** `remotecall` 的类名，可拿去类型搜索里找源码。 */
  remoteCall: string | null;
  /** 只用于展示，**不能拿来判严重性**（NC 的 debuglevel 是门限不是级别）。 */
  level: string | null;
  msg: string;
  stack: string[];
  stackTruncated: boolean;
  /** `warningsql` 的 costtime。 */
  costMs: number | null;
  rowCount: number | null;
  verdict: Verdict | null;
  /** 只有检索结果带：第一处命中的整行（列表用它回答「为什么命中」）。 */
  matchLine?: string;
  /** 只有检索结果带：命中的行数。 */
  matchCount?: number;
}

export interface QueryResult {
  entries: LogEntry[];
  /** 实际读过的文件 —— 让人知道结论的覆盖面，不是「全库都没问题」。 */
  scannedFiles: string[];
  recordsScanned: number;
  truncatedFiles: number;
  /** 已经凑满条数上限提前停了（还有文件没看）。 */
  stoppedEarly: boolean;
  elapsedMs: number;
  slowThresholdMs: number;
}

export interface TraceResult {
  callId: string;
  entries: LogEntry[];
  scannedFiles: string[];
  elapsedMs: number;
}

export interface QueryArgs {
  /** 空数组 / null = 全部 logger。 */
  loggers?: string[] | null;
  /** `2026-10-30 15:00:00`（本地墙上时间，字典序即时间序）。 */
  sinceTs?: string | null;
  untilTs?: string | null;
  onlyProblems?: boolean;
  minCostMs?: number;
  limit?: number;
}

export interface SearchArgs {
  /** 字面量或正则（由 `regex` 决定），空会被后端拒绝。 */
  query: string;
  regex: boolean;
  /** 默认忽略大小写；中文没有大小写，开了也只影响 ASCII。 */
  caseSensitive: boolean;
  loggers?: string[] | null;
  sinceTs?: string | null;
  untilTs?: string | null;
  limit?: number;
}

/** 检索命中的一条记录：记录本身 + 归因 + 「为什么命中」。 */
export interface SearchEntry extends LogEntry {
  /** 第一处命中的整行（后端已截断到 300 字），列表直接显示。 */
  matchLine: string;
  /** 命中的行数（同一行多次命中算 1）。 */
  matchCount: number;
}

export interface SearchResult {
  entries: SearchEntry[];
  scannedFiles: string[];
  recordsScanned: number;
  truncatedFiles: number;
  /** 已凑满条数上限提前停了（还有文件没看）。 */
  stoppedEarly: boolean;
  elapsedMs: number;
}

export function logSources(): Promise<SourceInfo> {
  return invoke<SourceInfo>("nc_log_sources");
}

export function queryLogs(args: QueryArgs): Promise<QueryResult> {
  return invoke<QueryResult>("nc_log_query", { args });
}

export function traceCall(callId: string): Promise<TraceResult> {
  return invoke<TraceResult>("nc_log_trace", { callId });
}

/** 全文/正则检索：看原文（msg / 堆栈 / 头部字段），不看归因。 */
export function searchLogs(args: SearchArgs): Promise<SearchResult> {
  return invoke<SearchResult>("nc_log_search", { args });
}

// ---------------------------------------------------------------- 时间

/**
 * 日志时间戳是**本地墙上时间**，定宽 `YYYY-MM-DD HH:mm:ss`。
 *
 * 后端用字符串比较做时间过滤（字典序即时间序），所以边界也必须按同一格式给，
 * 而不是传 epoch：转 epoch 得知道本机时区偏移，而 JS 的 `Date` 拿到的是本机
 * 时间字段，直接格式化反而是最不容易错的做法。
 */
export function logStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const TIME_RANGES = [
  { key: "none", label: "不限时间" },
  { key: "1h", label: "最近 1 小时" },
  { key: "today", label: "今天" },
  { key: "7d", label: "最近 7 天" },
] as const;

export type RangeKey = (typeof TIME_RANGES)[number]["key"];

/** 时间范围 → 起始时间串。`none` 返回 null（不过滤）。 */
export function sinceOf(range: RangeKey, now = new Date()): string | null {
  switch (range) {
    case "1h":
      return logStamp(new Date(now.getTime() - 3600_000));
    case "today":
      return logStamp(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0));
    case "7d":
      return logStamp(new Date(now.getTime() - 7 * 86400_000));
    default:
      return null;
  }
}

// ---------------------------------------------------------------- 展示

export interface SeverityMeta {
  /** Icon 组件名。 */
  icon: "alertTriangle" | "alert" | "clock";
  label: string;
}

export function severityMeta(severity: Severity): SeverityMeta {
  switch (severity) {
    case "error":
      return { icon: "alertTriangle", label: "错误" };
    case "slow":
      return { icon: "clock", label: "慢" };
    default:
      return { icon: "alert", label: "警告" };
  }
}

/** 列表里一行显示的标题：有结论用结论，否则用消息首行。 */
export function entryTitle(entry: LogEntry): string {
  if (entry.verdict) return entry.verdict.title;
  const first = entry.msg.split("\n")[0].trim();
  return first || entry.stack[0]?.trim() || "(空消息)";
}

/** 稳定标识：同一文件同一行就是同一条（刷新后仍能定位回选中项）。 */
export function entryKey(entry: LogEntry): string {
  return `${entry.file}:${entry.lineNo}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
