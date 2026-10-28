/**
 * NC 日志的增量拼装与逐行解析。
 *
 * 后端按「offset → 新增字节」给文本块，块边界可能切在任意字节上（后端会退让
 * 到完整字符，但不会保证切在行尾），所以这里必须留一个 pending 尾巴，
 * 等下一块拼齐了再成行——否则每块末尾都会出现一条被腰斩的日志。
 *
 * 数据只用在这一个面板里，不上传、不落盘。
 */

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogLine {
  /** 稳定 key（增量追加时不能靠下标）。 */
  id: number;
  /** `HH:MM:SS`，没有时间戳的续行是空串。 */
  time: string;
  thread: string;
  level: LogLevel;
  /** 异常栈的续行：不重复显示时间/线程/级别，整体缩进。 */
  stack: boolean;
  /** 形如 `nc.bs.framework.server.Server` 的 logger 名；解析不出就是空串。 */
  logger: string;
  text: string;
}

export interface LogState {
  lines: LogLine[];
  /** 上一块末尾没等到换行的半行。 */
  pending: string;
  nextId: number;
}

export const emptyLogState = (): LogState => ({ lines: [], pending: "", nextId: 1 });

/** 时间戳：`2026-10-28 09:31:02,123` 或 `09:31:02.123`，日期与毫秒都可省。 */
const TS_RE = /^(?:\d{4}-\d{2}-\d{2}[ T])?(\d{2}:\d{2}:\d{2})(?:[.,]\d{1,3})?\s*/;
/** 线程名：`[main]`、`[http-80-1]`、`[Timer-0]`。 */
const THREAD_RE = /^\[([^\]]{1,40})\]\s*/;
/** 级别：NC 用 log4j，就是这五个词。 */
const LEVEL_RE = /^(INFO|WARN|ERROR|DEBUG|FATAL|TRACE)\b[ \t]*/;
/** `logger - message` 的分隔。logger 满足「无空格且含点」才认，避免把普通句子切开。 */
const LOGGER_RE = /^([\w.$]{2,120}) - ([\s\S]*)$/;

/** 把一行原文解析成结构化行；解析不出时间/线程/级别就当异常栈续行。 */
export function parseLine(raw: string, id: number): LogLine {
  const text = raw.replace(/\r$/, "");
  let rest = text;
  let time = "";
  let thread = "";
  let level: LogLevel = "info";

  const ts = TS_RE.exec(rest);
  if (ts) {
    time = ts[1];
    rest = rest.slice(ts[0].length);
  }
  const th = THREAD_RE.exec(rest);
  if (th) {
    thread = th[1];
    rest = rest.slice(th[0].length);
  }
  const lv = LEVEL_RE.exec(rest);
  if (lv) {
    const word = lv[1];
    level = word === "ERROR" || word === "FATAL" ? "error" : word === "WARN" ? "warn" : word === "DEBUG" || word === "TRACE" ? "debug" : "info";
    rest = rest.slice(lv[0].length);
  }

  // 三个都没命中 = 异常栈的一行（`    at nc.bs...`、`Caused by: ...`）
  const isStack = !time && !thread && !lv;

  let logger = "";
  let body = rest;
  if (!isStack) {
    const lg = LOGGER_RE.exec(rest);
    if (lg) {
      logger = lg[1];
      body = lg[2];
    }
  }

  return { id, time, thread, level: isStack ? "info" : level, stack: isStack, logger, text: isStack ? text.trimEnd() : body };
}

/**
 * 追加一块文本。返回新的状态（不修改入参，便于 React 里直接比较引用）。
 *
 * `limit` 是保留的行数上限：中间件跑一整天能出几十万行，全留在内存里既吃内存
 * 又让每次渲染都重算，所以只留最后 N 行。N 取 4000，够回溯一次启动全过程。
 */
export function appendChunk(state: LogState, chunk: string, limit = 4000): LogState {
  if (!chunk) return state;
  const combined = state.pending + chunk;
  const parts = combined.split("\n");
  // 最后一段没有换行符：可能还有下半截，留到下一块
  const pending = parts.pop() ?? "";

  const lines = state.lines.slice();
  let id = state.nextId;
  for (const raw of parts) {
    if (raw.length === 0) continue;
    lines.push(parseLine(raw, id++));
  }
  // 半行太长（比如一次刷出一个大 JSON）时强制成行，免得 pending 无限涨
  if (pending.length > 4096) {
    lines.push(parseLine(pending, id++));
    return { lines: trim(lines, limit), pending: "", nextId: id };
  }
  return { lines: trim(lines, limit), pending, nextId: id };
}

function trim(lines: LogLine[], limit: number): LogLine[] {
  return lines.length > limit ? lines.slice(lines.length - limit) : lines;
}

export interface LogCounts {
  all: number;
  warn: number;
  error: number;
}

export function countLevels(lines: LogLine[]): LogCounts {
  let warn = 0;
  let error = 0;
  for (const l of lines) {
    if (l.level === "warn") warn++;
    else if (l.level === "error") error++;
  }
  return { all: lines.length, warn, error };
}

/**
 * 过滤：级别 + 关键字（大小写不敏感，匹配文本/logger/线程）。
 *
 * 异常栈行跟着它上一条非栈行走：只显示「错误」时，栈要一起显示，
 * 否则用户看到一条 ERROR 却不知道抛在哪儿。
 */
export function filterLines(lines: LogLine[], level: "all" | "warn" | "error", keyword: string): LogLine[] {
  const kw = keyword.trim().toLowerCase();
  if (level === "all" && !kw) return lines;

  const out: LogLine[] = [];
  let stackVisible = false;
  for (const line of lines) {
    if (line.stack) {
      if (stackVisible) out.push(line);
      continue;
    }
    const levelOk = level === "all" || (level === "warn" ? line.level === "warn" : line.level === "error");
    const kwOk =
      !kw ||
      line.text.toLowerCase().includes(kw) ||
      line.logger.toLowerCase().includes(kw) ||
      line.thread.toLowerCase().includes(kw);
    stackVisible = levelOk && kwOk;
    if (stackVisible) out.push(line);
  }
  return out;
}

/** 字节数转人能读的大小（日志页脚用）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 毫秒转 `12:34` / `1:02:03`（运行时长）。 */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
