import { invoke } from "./tauri";
import type { SchemaStatus } from "./db";

/**
 * 数据库页的后端命令封装与类型（多连接版）。
 *
 * 执行类命令（exec / more / tx / meta）回的是 Java 桥的原样 JSON，形状在这里定义；
 * 读写权限由数据库账号决定，前端只根据事务状态做提醒。
 */

export type DbEnv = "dev" | "test" | "prod" | "other";

export const ENV_LABEL: Record<DbEnv, string> = { dev: "开发", test: "测试", prod: "生产", other: "其他" };
export const ENVS: DbEnv[] = ["dev", "test", "prod", "other"];

export interface DbConn {
  id: string;
  name: string;
  env: DbEnv;
  /** `manual`：手动填写 / 导入 .properties；`prop`：NC prop.xml 的数据源（口令由 NC 现解）。 */
  source: "manual" | "prop";
  url: string;
  user: string;
  propDs: string | null;
  /** 默认事务模式：false = 手动提交。 */
  autoCommit: boolean;
  note: string;
  hasPassword: boolean;
}

export interface DbConnInput {
  id?: string | null;
  name: string;
  env: DbEnv;
  source: "manual" | "prop";
  url: string;
  user: string;
  propDs?: string | null;
  autoCommit: boolean;
  note?: string | null;
}

/** 手动提交模式下的未提交事务。`statements = 0` 表示没有。 */
export interface TxInfo {
  autoCommit: boolean;
  statements: number;
  rows: number;
  /** 开始时刻（毫秒时间戳），没有事务时为 0。 */
  since: number;
}

export type Cell = string | number | boolean | null;

export interface ColumnMeta {
  name: string;
  /** 带长度的类型名：`VARCHAR2(40)` / `NUMBER(28,8)`。 */
  type: string;
  precision: number;
  scale: number;
}

export interface RowsResult {
  kind: "rows";
  columns: ColumnMeta[];
  rows: Cell[][];
  rowCount: number;
  hasMore: boolean;
  ms: number;
  output: string[];
  tx: TxInfo;
}

export interface UpdateResult {
  kind: "update";
  /** DML 影响行数；DDL / PL/SQL 块为 -1 或 0。 */
  updateCount: number;
  ms: number;
  output: string[];
  tx: TxInfo;
}

export type ExecResult = RowsResult | UpdateResult;

export interface MoreResult {
  rows: Cell[][];
  rowCount: number;
  hasMore: boolean;
  ms: number;
}

export interface ConnectInfo {
  id: string;
  url: string;
  user: string;
  product: string;
  version: string;
  autoCommit: boolean;
}

export interface PropSource {
  name: string;
  url: string;
  user: string;
  type: string;
  isBase: boolean;
  hasPassword: boolean;
  added: boolean;
}

export interface TableInfo {
  name: string;
  kind: "TABLE" | "VIEW";
}

export interface ColumnInfo {
  name: string;
  type: string;
  size: number;
  /** `VARCHAR2(40)` 之类的完整类型。 */
  full: string;
  nullable: boolean;
  pk: boolean;
  default: string | null;
  comment: string | null;
  /** NC 元数据里的中文名（md_column.displayname），不是 NC 表就为 null。 */
  zh: string | null;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  status: string;
  columns: string;
}

export interface PlanRow {
  depth: number;
  operation: string;
  object: string;
  access: string;
  filter: string;
  cost: number | null;
  rows: number | null;
}

export interface TestResult {
  product: string;
  version: string;
  ms: number;
  tables: number | null;
}

/** 本地表结构缓存：小写表名 → [字段名, 类型][]（补全用）。 */
export interface SchemaCacheData {
  fetchedAt: number;
  tables: Record<string, [string, string][]>;
}

export const dbApi = {
  list: () => invoke<DbConn[]>("db_conn_list"),
  save: (conn: DbConnInput, password?: string, remember = true) =>
    invoke<DbConn>("db_conn_save", { conn, password: password || null, remember }),
  remove: (id: string) => invoke<DbConn[]>("db_conn_delete", { id }),
  reorder: (ids: string[]) => invoke<DbConn[]>("db_conn_reorder", { ids }),
  test: (conn: DbConnInput, password?: string) =>
    invoke<TestResult>("db_conn_test", { conn, password: password || null }),
  importProps: (text: string, file: string, name: string, env: DbEnv) =>
    invoke<DbConn>("db_conn_import_props", { text, file, name: name || null, env }),
  propSources: () => invoke<{ source: string; sources: PropSource[] }>("db_prop_sources"),
  propImport: (names: string[], env: DbEnv) => invoke<DbConn[]>("db_prop_import", { names, env }),

  connect: (id: string, password?: string, remember?: boolean) =>
    invoke<ConnectInfo>("db_connect", { id, password: password || null, remember: remember ?? null }),
  disconnect: (id: string) => invoke<void>("db_disconnect", { id }),
  exec: (id: string, sql: string, maxRows: number, timeoutSec: number) =>
    invoke<ExecResult>("db_exec", { id, sql, maxRows, timeoutSec }),
  more: (id: string, maxRows: number) => invoke<MoreResult>("db_more", { id, maxRows }),
  tx: (id: string, action: "commit" | "rollback" | "autocommit-on" | "autocommit-off" | "status") =>
    invoke<{ tx: TxInfo; alive?: boolean }>("db_tx", { id, action }),

  tables: (id: string) => invoke<{ tables: TableInfo[] }>("db_meta", { id, kind: "tables" }),
  ncNames: (id: string) => invoke<{ names: Record<string, string> }>("db_meta", { id, kind: "ncNames" }),
  columns: (id: string, table: string) =>
    invoke<{ columns: ColumnInfo[] }>("db_meta", { id, kind: "columns", arg: table }),
  indexes: (id: string, table: string) =>
    invoke<{ indexes: IndexInfo[] }>("db_meta", { id, kind: "indexes", arg: table }),
  ddl: (id: string, table: string) => invoke<{ ddl: string }>("db_meta", { id, kind: "ddl", arg: table }),
  explain: (id: string, sql: string) => invoke<{ plan: PlanRow[] }>("db_meta", { id, kind: "explain", arg: sql }),

  schemaCache: (id: string) => invoke<SchemaCacheData | null>("db_schema_cache", { id }),
  schemaSync: (id: string) => invoke<SchemaStatus>("db_schema_sync", { id }),
};

/** 连接串拆成「主机:端口」与「服务名 / SID」，以及是否 SID 写法（`@host:port:sid`）。 */
export function parseOracleUrl(url: string): { host: string; port: string; service: string; sid: boolean } | null {
  const m = /^jdbc:oracle:thin:@(?:\/\/)?([^:/]+):(\d+)([/:])(.+)$/i.exec(url.trim());
  if (!m) return null;
  return { host: m[1], port: m[2], service: m[4], sid: m[3] === ":" };
}

/** 由主机 / 端口 / 服务名拼 JDBC 连接串。 */
export function buildOracleUrl(host: string, port: string, service: string, sid: boolean): string {
  return `jdbc:oracle:thin:@${host.trim()}:${port.trim() || "1521"}${sid ? ":" : "/"}${service.trim()}`;
}

/** 连接串里最有辨识度的那段（服务名 / SID）。 */
export function dbNameOf(url: string): string {
  return parseOracleUrl(url)?.service ?? url;
}
