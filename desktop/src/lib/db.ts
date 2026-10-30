import { invoke } from "./tauri";

/**
 * 数据库相关的共用纯函数，以及表结构缓存 / 出包核对的命令封装。
 *
 * 数据库页本身（多连接、执行、事务、元数据）的命令在 `dbApi.ts`；这里留下的是
 * 补丁页、Java 悬停卡片也要用的部分，以及错误码的翻译。
 */

export interface DbColumn {
  name: string;
  /** 带长度的类型名：`VARCHAR2(40)`。 */
  type: string;
}

export type Cell = string | number | boolean | null;

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
  /** 对应的连接 id（还没有任何连接配置时为空）。 */
  connId: string | null;
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

/** 拉表结构：`id` 为空时用最近在数据库页用过的连接（要求它已连上）。 */
export const dbSchemaSync = (id?: string) => invoke<SchemaStatus>("db_schema_sync", { id: id ?? null });

export const dbCachedTables = () => invoke<CachedTables>("db_cached_tables");

export const dbColumns = (table: string) => invoke<DbTableColumns>("db_columns", { table });

export const dbCheckSources = (files: string[]) =>
  invoke<SourceCheck>("db_check_sources", { files });

// ───────────────────────── 错误码 ─────────────────────────

const KNOWN_CODES = new Set(["auth", "unreachable", "sql", "need-password", "not-connected", "bridge", "dup", "need-schema"]);

export interface DbError {
  code: "auth" | "unreachable" | "sql" | "need-password" | "not-connected" | "bridge" | "dup" | "need-schema" | "other";
  message: string;
}

/** 后端错误是 `code|message`（见 `commands/db_cmds.rs` 的 `code_label`）。 */
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
      return "这个连接还没存口令：输一次，之后会记住（Windows 加密存本机，换机器要重输）";
    case "auth":
      return `用户名或口令不对：检查连接里的用户名，或让 DBA 确认账号没被锁（${message}）`;
    case "unreachable":
      return `连不上数据库：检查网络 / VPN 是否通、服务名或 SID 是否写对（${message}）`;
    case "not-connected":
      return "这个连接还没连上：先在左侧点一下连接";
    case "bridge":
      return `数据库进程异常（超时或已退出），重新连接即可：${message}`;
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
 * 表名写错时给相近的建议（ORA-00942 是最常见的错）。
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

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * 0 = 不像，越大越像。不确定的一律不给建议——推荐一个错的表名比不推荐更糟。
 *
 * `knownSet.has(given)` 那条是必须的：查询里已经写了 `bd_material`（它本来就存在），
 * 就不能因为库里还有个 `bd_materialstock` 就把这条当成拼写错误。
 */
function proximity(given: string, known: string, knownSet: Set<string>): number {
  if (given === known) return 0;
  if (knownSet.has(given)) return 0;
  if (known.startsWith(given)) return 100 - (known.length - given.length);
  if (given.startsWith(known)) return 90 - (given.length - known.length);
  if (known.includes(given) || given.includes(known)) return 50;
  const cp = commonPrefix(given, known);
  const shorter = Math.min(given.length, known.length);
  if (cp >= Math.max(6, Math.floor(shorter * 0.8))) return 30;
  return 0;
}

/** 单元格显示文本。NULL 单独标出来——空串和 NULL 在排障时完全是两回事。 */
export function cellText(v: Cell, max = 400): string {
  if (v === null || v === undefined) return "NULL";
  const s = typeof v === "string" ? v : String(v);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** `128` → `128`，`3128` → `3,128`。表数量级要一眼看出来。 */
export function thousands(n: number): string {
  return n.toLocaleString("zh-CN");
}
