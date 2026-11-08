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

const KNOWN_CODES = new Set([
  "auth",
  "unreachable",
  "sql",
  "need-password",
  "not-connected",
  "session-lost",
  // 语句没跑完（点了停止或超过等待超时），会话还在——不要跟 `bridge` 混为一谈
  "timeout",
  "fallback-session-lost",
  "probe-failed",
  "bridge",
  "dup",
  "need-schema",
  // A0 会话槽：`slot-gone` = 槽被空闲回收 / 连接断开，重执行一次会自动重开
  "slot-gone",
  // 一条连接上的独立会话用满了（最多 3 个）
  "slots-full",
  // 这个操作需要 NC 安装目录（prop.xml 口令要 NC 的类）
  "need-nc-home",
  // 这个操作需要一套 Java 运行时 + Oracle 驱动。装了 NC 就有，没装的话可以由
  // `ncdb` 资源包或系统 Java 提供——所以它和 `need-nc-home` 是两件事：
  // 前者要 NC 的类，后者只要一个 JVM。界面据此给出「下载组件」或「换引擎」。
  "need-jvm",
  // 同一个重活已经有一个在跑（如两条表结构同步），稍后再试即可
  "busy",
  // Rust 引擎跑不了这条语句，已改在 JVM 桥的临时会话里执行；那条会话已经回滚，
  // 写入没有生效。这个码必须能认出来，否则界面会把「写入被回滚」显示成内部错误。
  "fallback-tx",
]);

export interface DbError {
  code:
    | "auth"
    | "unreachable"
    | "sql"
    | "need-password"
    | "not-connected"
    | "session-lost"
    | "timeout"
    | "fallback-session-lost"
    | "probe-failed"
    | "bridge"
    | "dup"
    | "need-schema"
    | "slot-gone"
    | "slots-full"
    | "need-nc-home"
    | "need-jvm"
    | "busy"
    | "fallback-tx"
    | "other";
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
      return "这个连接还没存口令：输一次就行（Windows 用 DPAPI、macOS 用钥匙串加密存本机，换机器要重输）";
    case "auth":
      return `用户名或口令不对：检查连接里的用户名，或让 DBA 确认账号没被锁（${message}）`;
    case "unreachable":
      // 后端只说事实（TCP 超时 / 被拒 / ORA-12541），建议统一在这里给
      return `连不上数据库：${message}（检查网络 / VPN 是否通、端口与服务名是否写对）`;
    case "not-connected":
      return "这个连接还没连上：先在左侧点一下连接";
    case "timeout":
      // 只是不该落到 `bridge` 的「进程异常」文案上：原文「语句已中断…会话仍然可用」就是对的
      return message;
    case "need-jvm":
      // 后端已经把三条出路写全（配 NC / 下组件 / 换引擎），这里不再重复
      return message;
    case "bridge":
      return `数据库进程异常（超时或已退出），重新连接即可：${message}`;
    case "busy":
      // 后端给的是「已有表结构同步正在进行」，换个说法也别再让人以为是自己点坏了
      return `上一个同类操作还没结束，稍等再试：${message}`;
    case "fallback-tx":
      // 这条最容易被误读成普通报错：必须让人看到「写入没有生效」
      return `这条语句只能在 JVM 桥的临时会话里执行，写入已被回滚、没有生效：${message}`;
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

/**
 * 后端「大文本预览」的尾部标记。
 *
 * 🔴 与 Rust `db_rust.rs::preview_text`、Java `NcDbBridge.java::clobText` 是同一份文案：
 * 改一边必须改三边，否则「加载完整值」按钮会认不出来。
 */
const LOB_PREVIEW_RE = / …（共 ([^）]*) 个字符，只显示前 \d+，点「加载完整值」查看）$/;

/** 这格是不是被后端截断的大文本预览（结果集里 CLOB 只带前 8K 字符）。 */
export function isLobPreview(v: Cell): v is string {
  return typeof v === "string" && LOB_PREVIEW_RE.test(v);
}

/**
 * 去掉预览尾部那段中文说明，只留正文。
 *
 * 解码前必须走这一步：`7B22…307D …（共 39 个字符，只显示前 8192…）` 里混着中文，
 * 直接判「是不是全 hex 字符」永远失败，看着就像「这列不是编码」。
 */
export function lobPreviewBody(v: Cell): string {
  return typeof v === "string" ? v.replace(LOB_PREVIEW_RE, "") : "";
}

/** 大文本预览里的总字符数（原值长度）；不是预览返回 null。 */
export function lobPreviewChars(v: Cell): number | null {
  if (typeof v !== "string") return null;
  const m = LOB_PREVIEW_RE.exec(v);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * 编辑前的值算不算「没改」。
 *
 * 编辑器里拿到的永远是字符串（输入框），而查询结果的数字/布尔是原生类型：
 * 直接用 `===` 比，`"128" !== 128`，双击后原样回车也会被记成改动，
 * 于是标黄、生成一条同值 UPDATE、写回时还报「预期更新 1 行」——全是假的。
 * NULL 与空串不在这里合并：Oracle 里空串就是 NULL，由调用方先归一。
 */
export function sameCell(a: Cell, b: Cell): boolean {
  return a === b || (a !== null && b !== null && String(a) === String(b));
}

/** `128` → `128`，`3128` → `3,128`。表数量级要一眼看出来。 */
export function thousands(n: number): string {
  return n.toLocaleString("zh-CN");
}
