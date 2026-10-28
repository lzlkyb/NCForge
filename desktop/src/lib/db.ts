import { invoke } from "./tauri";

/**
 * 只读 SQL 面板（M7）的命令封装与纯函数。
 *
 * 只读是**后端三道光**保证的（语句白名单 → `SET TRANSACTION READ ONLY` → 执行后 rollback），
 * 前端这里再挡一道「明显不是查询」的输入，纯粹是为了少走一次往返、把话说在人前面。
 * 判断以「挡得住手滑」为标准，不追求完整 SQL 解析——真正的把关在桥里。
 */

export interface PropDbSummary {
  url: string;
  user: string;
  databaseType: string;
  /** prop.xml 里 `isEncode=true`：口令是 NC 加密格式，我们解不开。 */
  passwordEncoded: boolean;
  source: string;
}

export interface DbDefaults {
  url: string | null;
  user: string | null;
  databaseType: string | null;
  /** 连接串的来源文件（界面上显示「取自哪」）。 */
  source: string;
  hasPassword: boolean;
  passwordNeedsInput: boolean;
  driverFound: boolean;
  driverPath: string | null;
}

export interface DbColumn {
  name: string;
  /** 带长度的类型名：`VARCHAR2(40)`。 */
  type: string;
  precision?: number;
  scale?: number;
}

export type Cell = string | number | boolean | null;

export interface QueryResult {
  columns: DbColumn[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
  sql: string;
}

export interface DbConnectResult {
  url: string;
  user: string;
  product: string;
  version: string;
  readOnly: boolean;
}

export interface DbTable {
  name: string;
  /** `TABLE` / `VIEW`。 */
  kind: string;
}

export const dbDefaults = () => invoke<DbDefaults>("db_defaults");

/** `password` 为空 = 用配置里存过的（DPAPI 解出来的）。 */
export const dbConnect = (password?: string) =>
  invoke<DbConnectResult>("db_connect", { password: password ?? null });

export const dbQuery = (sql: string, maxRows?: number, timeoutSec?: number) =>
  invoke<QueryResult>("db_query", {
    sql,
    maxRows: maxRows ?? null,
    timeoutSec: timeoutSec ?? null,
  });

export const dbTables = () => invoke<DbTable[]>("db_tables");

export const dbDisconnect = () => invoke<void>("db_disconnect");

// ───────────────── 表结构缓存与出包核对 ─────────────────

export interface SchemaStatus {
  has: boolean;
  url: string;
  user: string;
  /** 拉取时刻（Unix 秒），没有缓存时为 0。 */
  fetchedAt: number;
  ageSecs: number;
  tables: number;
  columns: number;
}

export interface CachedTables {
  tables: string[];
  fetchedAt: number;
  url: string;
  user: string;
}

export interface DbTableColumns {
  table: string;
  columns: DbColumn[];
  fromCache: boolean;
}

export interface CheckIssue {
  /** `table`（表不存在）/ `column`（字段不存在）。 */
  kind: "table" | "column";
  table: string;
  column: string | null;
  /** 相对工作区根的路径。 */
  rel: string;
  abs: string;
  line: number;
  suggestions: string[];
}

export interface SourceCheck {
  files: number;
  skipped: number;
  tables: number;
  columns: number;
  missingTables: number;
  missingColumns: number;
  issues: CheckIssue[];
  schemaTables: number;
  schemaAgeSecs: number;
}

export const dbSchemaStatus = () => invoke<SchemaStatus>("db_schema_status");

export const dbSchemaSync = () => invoke<SchemaStatus>("db_schema_sync");

export const dbCachedTables = () => invoke<CachedTables>("db_cached_tables");

export const dbColumns = (table: string) => invoke<DbTableColumns>("db_columns", { table });

export const dbCheckSources = (files: string[]) =>
  invoke<SourceCheck>("db_check_sources", { files });

// ───────────────────────── 纯函数 ─────────────────────────

const KNOWN_CODES = new Set(["auth", "unreachable", "sql", "need-password"]);

export interface DbError {
  code: "auth" | "unreachable" | "sql" | "need-password" | "other";
  message: string;
}

/** 后端错误是 `code|message`（见 `commands/db_cmds.rs` 的 `map_sql_error`）。 */
export function parseDbError(e: unknown): DbError {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  const idx = text.indexOf("|");
  if (idx > 0) {
    const code = text.slice(0, idx);
    if (KNOWN_CODES.has(code)) {
      return { code: code as DbError["code"], message: text.slice(idx + 1) };
    }
  }
  return { code: "other", message: text };
}

/** 给用户看的一句话。ORA 错误号保留在正文里，工程师排障要它。 */
export function friendlyDbError(e: unknown): string {
  const { code, message } = parseDbError(e);
  switch (code) {
    case "need-password":
      return "第一次连这个库要输一次密码，之后会记住（存在本机，换机器要重输）";
    case "auth":
      return "用户名或口令不对：检查连接对话框里的用户名，或让 DBA 确认账号没被锁";
    case "unreachable":
      return "连不上数据库：检查网络 / VPN 是否通，以及库是不是起着";
    default:
      return message;
  }
}

/** ORA 号从错误文本里抠出来：`ORA-00942: 表或视图不存在`。 */
export function oraCode(message: string): string | null {
  const m = /ORA-\d{5}/i.exec(message);
  return m ? m[0].toUpperCase() : null;
}

/**
 * 表名写错时给相近的建议（ORA-00942 是这种查询最常见的错）。
 *
 * 只做两件事：包含关系 + 去掉 `_x` / 末尾数字这种手滑痕迹后相等。
 * 不上编辑距离——`bd_material` 与 `bd_materialx` 的编辑距离和几十个无关表一样近，
 * 反而会推一堆噪音。
 */
export function similarTables(sql: string, known: string[], limit = 3): string[] {
  const targets = tableRefs(sql);
  if (targets.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of targets) {
    for (const name of similarTo(t, known, limit)) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 单个表名找相近候选（错误消息里只有表名、没有整条 SQL 时用这个）。 */
export function similarTo(given: string, known: string[], limit = 3): string[] {
  const g = given.toLowerCase();
  if (!g) return [];
  const knownSet = new Set(known.map((k) => k.toLowerCase()));
  const scored: { name: string; best: number }[] = [];
  for (const raw of known) {
    const name = raw.toLowerCase();
    if (name.length < 4) continue;
    const score = proximity(g, name, knownSet);
    if (score > 0) scored.push({ name: raw, best: score });
  }
  scored.sort((a, b) => b.best - a.best);
  return scored.slice(0, limit).map((x) => x.name);
}

/** from / join 后面出现的表名（含 `schema.table` 的末段）。 */
export function tableRefs(sql: string): string[] {
  const out: string[] = [];
  const re = /\b(?:from|join)\s+([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const parts = m[1].split(".");
    out.push(parts[parts.length - 1]);
  }
  return out;
}

/** 两个串的公共前缀长度。 */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * 0 = 不像，越大越像。
 *
 * 规则按「确定性」排序，不确定的一律不给建议——推荐一个错的表名比不推荐更糟，
 * 用户会照着它再错一次。
 *
 * `knownSet.has(given)` 那条是必须的：查询里已经写了 `bd_material`（它本来就存在），
 * 就不能因为库里还有个 `bd_materialstock` 就把这条当成拼写错误——否则每次查
 * `bd_material` 都会冒出一条「你是不是想查 bd_materialstock」的噪音。
 */
function proximity(given: string, known: string, knownSet: Set<string>): number {
  if (given === known) return 0;
  if (knownSet.has(given)) return 0;
  if (known.startsWith(given)) return 100 - (known.length - given.length);
  if (given.startsWith(known)) return 90 - (given.length - known.length);
  if (known.includes(given) || given.includes(known)) return 50;
  // 截断：`bd_material_st` 与 `bd_materialstock` 前缀高度重合但两边都不包含对方
  const cp = commonPrefix(given, known);
  const shorter = Math.min(given.length, known.length);
  if (cp >= Math.max(6, Math.floor(shorter * 0.8))) return 30;
  return 0;
}

/**
 * 前端这一道只挡「一眼就知道不是查询」的输入：空、多语句、明确以写操作开头。
 * 与后端 `checkReadOnly` 不同的地方：后端还要去掉字符串常量再判断，
 * 这里挡不住也**不应该**因此放行——挡不住就交给后端，绝不放宽。
 */
export function precheckSql(sql: string): string | null {
  const t = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!t) return "SQL 是空的";
  // 分号只允许出现在末尾（一个分号结尾是习惯，多个就是多语句）
  const semis = (t.match(/;/g) ?? []).length;
  if (semis > 1 || (semis === 1 && !t.endsWith(";"))) {
    return "只放行单条语句：把多余的 ; 去掉，或拆成几次执行";
  }
  const first = /^[a-z]+/i.exec(t)?.[0]?.toLowerCase() ?? "";
  if (first === "select" || first === "with") return null;
  if (["insert", "update", "delete", "merge", "drop", "alter", "create", "truncate", "grant", "call", "begin", "declare"].includes(first)) {
    return `「${first}」是写操作：这个面板只放行 select / with，改数据请走正式脚本`;
  }
  return null; // 认不出开头就交给后端判，不在这里瞎拦
}

/** 单元格显示文本。NULL 单独标出来——空串和 NULL 在排障时完全是两回事。 */
export function cellText(v: Cell, max = 400): string {
  if (v === null || v === undefined) return "NULL";
  const s = typeof v === "string" ? v : String(v);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** 数字列右对齐（靠类型名判断，不靠值——一列里混了 NULL 也要对齐）。 */
export function isNumericType(type: string): boolean {
  return /^(NUMBER|FLOAT|INTEGER|INT|DECIMAL|NUMERIC|BINARY_DOUBLE|BINARY_FLOAT)/i.test(type);
}

/** 复制为 TSV：制表符分隔、NULL 写成空（粘进 Excel 才不会变成字符串 `NULL`）。 */
export function toTsv(columns: DbColumn[], rows: Cell[][]): string {
  const head = columns.map((c) => c.name).join("\t");
  const body = rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : String(v))).join("\t"));
  return [head, ...body].join("\n");
}

/** `128` → `128`，`3128` → `3,128`。表数量级要一眼看出来。 */
export function thousands(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 连接串拆成「主机:端口/库名」+ 用户名，连接胶囊上分行显示。 */
export function splitJdbcUrl(url: string): { host: string; database: string } {
  const m = /@([^:/]+(?::\d+)?)\/([^?]+)/.exec(url);
  if (!m) return { host: url, database: "" };
  return { host: m[1], database: m[2] };
}
