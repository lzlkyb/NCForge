import { invoke } from "./tauri";
import { parseDbError } from "./db";
import { friendlyError } from "./friendlyError";

/**
 * 数据字典的接口层。**与 Rust `commands/md_dict_cmds.rs` / `md_dict.rs` 一一对应**
 * （camelCase；`Option` 序列化为 null）。
 *
 * 这里只放类型、取值与「三种选表方式怎么落到一次请求上」，不放任何文案判断 ——
 * 单条错误怎么说归后端（`code_label`），前端只负责摆出来。
 */

/** 表清单里的一行。**没有列数**：那要再查一次分组计数，300 多张表要多花 1 秒，
 *  而它并不影响「勾不勾这张表」的决定。列数在生成后的表卡片抬头里给。 */
export interface TableBrief {
  name: string;
  displayName: string;
  /** 二开扩展表。这类表最需要字典，界面上要标出来。 */
  isExtend: boolean;
  module: string;
}

export interface TablesOut {
  tables: TableBrief[];
  /** 命中的表比请求的 limit 多（列表可以截断，字典不行）。 */
  truncated: boolean;
  source: string;
}

/** 左栏的一行。`missing` 只出现在「补丁涉及」：补丁草稿里写了这个表名，
 *  但库里查不到（拼错、或元数据还没发布）。这种行不能勾，勾了也只会被跳过。 */
export interface PickRow extends TableBrief {
  missing?: boolean;
}

/** 与 Rust `TableFilter` 同构。三个条件同时给出时后端取**交集**，
 *  但界面只允许同时出现一个 —— 见下方 `Scope` 的说明。 */
export interface TableFilter {
  names: string[];
  prefix: string;
  keyword: string;
}

export interface PropRef {
  name: string;
  displayName: string;
}

export interface ColumnDict {
  name: string;
  displayName: string;
  /** 已格式化好的类型（如 `VARCHAR2(200)`、`参照:物料`），直接显示。 */
  type: string;
  pkey: boolean;
  nullable: boolean;
  seq: number | null;
  /** 映射到这一列的实体属性，可能多个（`md_ormap` 是 1:N），也可能为空。 */
  props: PropRef[];
}

export interface EntityRef {
  className: string;
  fullClassName: string;
  columns: number;
}

export interface TableDict {
  name: string;
  displayName: string;
  isExtend: boolean;
  module: string;
  resid: string;
  entities: EntityRef[];
  columns: ColumnDict[];
  /** 组装时发现的问题（缺中文名、多个实体、没有列定义）。不是装饰：
   *  字典要能自己说明哪里不可信，否则用户没法判断该不该依赖它。 */
  notes: string[];
}

export interface MdDictOut {
  tables: TableDict[];
  tableCount: number;
  columnCount: number;
  /** 没有中文名的列数，界面据此提示「这份字典有多完整」。 */
  columnsWithoutName: number;
  /** 请求了但库里没有的表（名字写错、或元数据还没发布）。生成时跳过，不报错。 */
  missing: string[];
  /** 后端给的口径描述，如「指定 2 张表」「前缀 bd_」。 */
  selection: string;
  source: string;
  elapsedMs: number;
}

/** 单次最多多少张表（与 Rust `md_dict_sql::MAX_TABLES` 必须一致）。 */
export const MAX_TABLES = 500;

/**
 * 表清单（左栏搜索用）。`limit` 是列表上限，可以截断。
 *
 * `connId` 显式带上：数据库页里可能同时开着几个库，不传时后端退回「当前连接」，
 * 用户看着 A 库的标签、字典却读成 B 库，生成物没有任何地方能看出来。
 */
export const mdTables = (filter: TableFilter, limit = 200, connId: string | null = null) =>
  invoke<TablesOut>("nc_md_tables", { filter, limit, id: connId });

/** 生成字典。截断在这是**错误**：缺列的字典比报错更坏。 */
export const mdDict = (filter: TableFilter, connId: string | null = null) =>
  invoke<MdDictOut>("nc_md_dict", { filter, id: connId });

/**
 * 字典命令的错误 → 人话。
 *
 * 后端抛的是 `code|message`。`friendlyDbError` 的码表里有 `not-connected`，但它会
 * 换成一句通用的「先在左侧点一下连接」——那对数据库页合适，对字典页不准（这里的
 * 前置条件是「去数据库页连上库」）。所以这一类直接用后端原文，其余照常翻译。
 */
export function mdErrorText(e: unknown): string {
  const { code, message } = parseDbError(e);
  if (code === "not-connected") return message;
  return friendlyError(e, "db");
}

// ───────────────────────── 产出：CSV / Markdown ─────────────────────────

export type DocFormat = "csv" | "md";

/**
 * 交给后端渲染的那份字典 —— **就是屏幕上这一份**。
 *
 * 不让后端按 filter 重查一次：重查要多等 2~3 秒，中间元数据一变，导出的文件就和
 * 用户刚看过的那份不一样。「导出我看到的东西」才是预期。
 */
export interface DictDoc {
  tables: TableDict[];
  selection: string;
  source: string;
  /** 本地时间 `YYYY-MM-DD HH:mm`。Rust 侧没有时区库，时间只能这边给。 */
  generated: string;
}

export interface ExportOut {
  path: string;
  name: string;
  bytes: number;
  /** 所在目录，界面上直接显示，省得用户自己找。 */
  dir: string;
}

/**
 * 本地时间戳 `YYYY-MM-DD HH:mm`。
 *
 * 手写而不是 `toLocaleString`：后者给的是 `2026/11/2 12:20`，斜杠要再洗一遍才能进文件名，
 * 而且不同 locale 结果不一样（同一份字典在两台机器上导出的文件抬头会不同）。
 */
export function stampText(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把一次生成的结果打包成导出请求。 */
export function dictDocOf(data: MdDictOut, generated = stampText()): DictDoc {
  return { tables: data.tables, selection: data.selection, source: data.source, generated };
}

/** 渲染成文本（复制用，不落盘）。**与导出走同一条渲染**，否则两处排版会各自漂移。 */
export const mdDictText = (doc: DictDoc, format: DocFormat) =>
  invoke<{ text: string; bytes: number }>("nc_md_dict_text", { doc, format });

/** 渲染并写文件，落在 `{config_dir}/exports`（与 SQL 导出同一个目录）。 */
export const mdDictExport = (doc: DictDoc, format: DocFormat) =>
  invoke<ExportOut>("nc_md_dict_export", { doc, format });

/** 在系统文件管理器里定位导出文件。复用数据库导出的命令：它同样只允许 exports 目录内的路径。 */
export const mdDictReveal = (path: string) => invoke<void>("db_export_reveal", { path });

// ───────────────────────── 三种选表方式 ─────────────────────────

/**
 * 界面上的选表范围。**三种互斥**。
 *
 * 后端 `TableFilter` 允许 names / prefix / keyword 同时给并取交集，但界面上如果
 * 同时开放，用户勾了 20 张、又填了 `bd_` 前缀、结果只出 5 张 —— 没有任何提示能
 * 解释这个落差（A 批的 `selection` 只会写「指定 20 张表 · 前缀 bd_」，读起来像
 * 20 张全在）。所以这里把它收成一个和式类型：切换即替换，生成时只带一路条件。
 */
export type Scope =
  | { kind: "picked"; names: string[] }
  | { kind: "prefix"; prefix: string }
  | { kind: "patch"; names: string[] };

export type ScopeKind = Scope["kind"];

/** 转成后端要的 filter。关键词只在左栏找表时用，不进这里。 */
export function scopeFilter(s: Scope): TableFilter {
  if (s.kind === "prefix") {
    return { names: [], prefix: s.prefix.trim(), keyword: "" };
  }
  return { names: dedupeNames(s.names), prefix: "", keyword: "" };
}

/** 这一路范围是不是还空着（空着就不该发请求）。 */
export function scopeEmpty(s: Scope): boolean {
  return s.kind === "prefix" ? !s.prefix.trim() : dedupeNames(s.names).length === 0;
}

/** 生成按钮旁边的范围摘要（比后端返回的 selection 更早出现，用于「点了会发生什么」）。 */
export function scopeLabel(s: Scope): string {
  if (s.kind === "prefix") return s.prefix.trim() ? `前缀 ${s.prefix.trim()}` : "还没填前缀";
  const n = dedupeNames(s.names).length;
  return n ? `${n} 张表` : "还没选表";
}

/** 大小写不敏感去重，保留首次出现的大小写（表名大小写在界面上是给人看的）。 */
export function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

/**
 * 扫表逻辑搬到 `lib/sqlTables.ts` 了：SQL 结果的列中文名也要用（按 SQL 里的表反查
 * `md_column`），留在字典模块里会让数据库控制台为了几个表名把整页数据字典一起拽进来。
 * 这里 re-export 保持既有调用点与测试不动。
 */
export { sqlTables, type PatchTable } from "./sqlTables";

