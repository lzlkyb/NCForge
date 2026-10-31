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
  /** 执行引擎：`java` = 常驻 JVM + JDBC（默认），`rust` = 纯 Rust 驱动（省内存、不常驻 JVM）。 */
  engine: DbEngine;
}

/**
 * 执行引擎。**这是连接级属性**，不是全局开关：同一个库同一份 SQL，两条路的资源代价与
 * 能力不一样（见 {@link EngineCaps}），而「要不要解 prop.xml 口令」本身就是连接带来的。
 */
export type DbEngine = "java" | "rust";

export const ENGINE_LABEL: Record<DbEngine, string> = { java: "JVM 桥", rust: "纯 Rust 驱动" };

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
  /** 不传就是 JVM 桥。
   * prop 来源的连接也能选纯 Rust：第一次连接时后端会用 JVM 解一次口令并加密存本机。 */
  engine?: DbEngine;
}

/** 这个连接用哪个引擎、那个引擎能做什么。界面按它决定按钮能不能用。 */
export interface EngineCaps {
  engine: DbEngine;
  label: string;
  /** 已经连上了（能力来自真实句柄，不是按配置猜的）。 */
  connected: boolean;
  /** 语句执行中能取消。为 false 时「停止」按钮是灰的——不能骗用户说停了。 */
  cancel: boolean;
  refcursor: boolean;
  /** 能解 NC prop.xml 里加密的口令。 */
  propDecrypt: boolean;
  multiSession: boolean;
  /** 能列会话与锁（`v$session` / `v$locked_object`）。权限不够由返回的 `granted` 表达。 */
  sessions: boolean;
  /** 执行时能回实际统计（逻辑读/物理读）。账号读不到统计视图时响应里 `stats` 为 null。 */
  stats: boolean;
}

/**
 * 一次执行的实际开销（Autotrace）。由后端在执行前后各读一次 `v$mystat` 取差值。
 *
 * `null` = 这个账号读不到统计视图（没有 `V_$MYSTAT` 授权），**不是 0**：
 * 界面必须整行不显示，而不是显示一排 0 让人以为这条 SQL 没花成本。
 */
export interface ExecStats {
  /** 当前读（`db block gets`）。 */
  dbBlockGets: number;
  /** 一致读（`consistent gets`）。 */
  consistentGets: number;
  /** 逻辑读 = 当前读 + 一致读，后端已经算好，前端别自己再加一遍。 */
  logicalReads: number;
  physicalReads: number;
  executeCount: number;
}

/** 一条会话（锁与会话面板的一行）。字段名与两个引擎的 JSON 严格一致。 */
export interface SessionRow {
  sid: number;
  serial: number | null;
  user: string;
  machine: string;
  program: string;
  status: string;
  /** 阻塞它的 SID；没有被阻塞时为 null。 */
  blocker: number | null;
  event: string;
  waitClass: string;
  /** 已等待秒数（`v$session.seconds_in_wait`）。 */
  waitSec: number;
  /** 本会话当前调用已执行秒数（`last_call_et`）。 */
  elapsedSec: number;
  sqlId: string;
  /** 该会话锁住的对象，形如 `OWNER.TABLE(TABLE,L6)`。 */
  locked: string[];
  /** SQL 文本（截 300 字符）；低权限账号读不到 `v$sql` 时为空。 */
  sql: string;
}

export interface SessionsResult {
  rows: SessionRow[];
  /** false = 这个账号读不到 `v$locked_object`，锁信息不可见（**不是**「没有锁」）。 */
  granted: boolean;
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

/**
 * 一个结果集。只有 `dbms_sql.return_result`（PL/SQL 自己开游标返回）这类语句才有多个，
 * 普通查询就是一个。
 */
export interface ResultSet {
  columns: ColumnMeta[];
  rows: Cell[][];
  rowCount: number;
  /**
   * 取到「每次取 N 行」的上限还有剩余。
   *
   * 隐式结果集**不支持**「加载更多」：一条会话只留一个分页游标，多结果集时没法每个都留。
   * 界面上这里只提示调大行数重跑，不要给「加载下 N 行」按钮。
   */
  hasMore: boolean;
}

export interface RowsResult {
  kind: "rows";
  columns: ColumnMeta[];
  rows: Cell[][];
  rowCount: number;
  hasMore: boolean;
  /** `dbms_sql.return_result` 带回的全部结果集（顺序与 `return_result` 一致）。 */
  sets?: ResultSet[];
  ms: number;
  /** 实际执行统计；`null` = 这个账号读不到 `v$mystat`。 */
  stats?: ExecStats | null;
  output: string[];
  tx: TxInfo;
}

export interface UpdateResult {
  kind: "update";
  /** DML 影响行数；DDL / PL/SQL 块为 -1 或 0。 */
  updateCount: number;
  ms: number;
  stats?: ExecStats | null;
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

/** 导出 insert 脚本的请求：取数语句 + 目标表 + 三条 NC 规则的开关。 */
export interface ExportInsertReq {
  id: string;
  /** 取数语句（整表导出就是 `select * from <表>`）。 */
  sql: string;
  /** 写进 `insert into` 的目标表名。 */
  table: string;
  schema?: string | null;
  /** `false` = 不按 NC 多语约定，`X2`..`X6` 原样导出。默认 true。 */
  multilang?: boolean;
  /** 每 N 行插一条 `commit;`，0 = 不插。 */
  commitEvery?: number;
  maxRows?: number;
  timeoutSec?: number;
}

export interface ExportInsertResult {
  fileName: string;
  sqlText: string;
  rows: number;
  /** 到行数上限还有剩余：脚本不是全量。 */
  truncated: boolean;
  blobNulls: number;
  mlTildes: number;
  /** 识别到的多语列族，如 `name（跳过 name2..name6）`。 */
  multilang: string[];
  /** 因多语规则被丢掉的列名。 */
  dropped: string[];
  warnings: string[];
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

/** 非表对象（包 / 过程 / 序列 / 同义词 / 触发器…）。`type` 就是 `user_objects.object_type`。 */
export interface DbObject {
  name: string;
  type: string;
  status: string;
  created: string | null;
}

/** 源码的一行。`type` 用来区分 `PACKAGE` 与 `PACKAGE BODY`（同名对象各有一段）。 */
export interface SourceLine {
  type: string;
  line: number;
  text: string;
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

/** `db_pending_tx` 的一行：某个连接退出时的事务情况。 */
export interface PendingTxRow {
  id: string;
  /** `pending` 有未提交写入；`clean` 干净；`unknown` 探测超时/连接已断。 */
  state: "pending" | "clean" | "unknown";
  engine?: string;
  statements?: number;
  rows?: number;
  since?: number;
  message?: string;
}

/**
 * 流式导出请求（A4）：后端按页取、按行写文件，内存峰值 O(一页)。
 *
 * 与 `ExportInsertReq` 的区别：那个带 NC 多语/主键规则、一次拼出整段文本、上限 10 万行；
 * 这个只管「把结果集打印成文件」，行数可以大得多。
 */
export interface ExportFileReq {
  id: string;
  sql: string;
  format: "csv" | "tsv" | "insert";
  /** INSERT 的目标表名；其余格式只用来命名文件。 */
  table?: string | null;
  /** 期望文件名（**前端带时间戳**，本机时区；后端没有 chrono）。 */
  fileName?: string | null;
  /** 0 / 不传 = 不限（后端仍有 200 万行硬上限，到了会标 `truncated`）。 */
  maxRows?: number;
  timeoutSec?: number;
}

export interface ExportFileOut {
  path: string;
  fileName: string;
  rows: number;
  bytes: number;
  /** 到行数上限还有剩余：文件不是全量。 */
  truncated: boolean;
  ms: number;
}

/** 导出进度事件（`db:export-progress`）。 */
export interface ExportProgress {
  id: string;
  rows: number;
}

/** `db_slot_acquire` 的结果：本标签要用的独立会话槽名（数字字符串）。 */
export interface SlotOut {
  slot: string;
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
  /**
   * 执行一条语句。`slot` 为空 = primary（元数据 / 表页 / 事务条那条会话）；
   * SQL 标签申请到槽之后，执行、加载更多、取消、事务都必须带同一个槽名。
   */
  exec: (id: string, sql: string, maxRows: number, timeoutSec: number, slot?: string | null) =>
    invoke<ExecResult>("db_exec", { id, sql, maxRows, timeoutSec, slot: slot || null }),
  /** 给一个 SQL 标签再开一条独立会话。最多 3 个/连接，超出报 `slots-full`。 */
  slotAcquire: (id: string) => invoke<SlotOut>("db_slot_acquire", { id }),
  /** 关标签时释放；断开连接时后端会连带收掉全部槽。 */
  slotRelease: (id: string, slot: string) => invoke<void>("db_slot_release", { id, slot }),
  /**
   * 导出 insert 脚本：后端单独开会话把游标读到空，按 NC 的三条格式规则生成脚本。
   * 前端拿到整段文本再落盘（`resultExport.downloadText`）。
   */
  exportInsert: (req: ExportInsertReq) => invoke<ExportInsertResult>("db_export_insert", { req }),
  /**
   * 流式导出到文件（CSV / TSV / INSERT）。后端按页取数、按行写盘，
   * 进度走 `db:export-progress` 事件；返回落盘路径，界面用 `revealExport` 定位。
   */
  exportFile: (req: ExportFileReq) => invoke<ExportFileOut>("db_export_file", { req }),
  /** 在系统文件管理器里定位刚导出的文件（只允许导出目录内的路径）。 */
  revealExport: (path: string) => invoke<void>("db_export_reveal", { path }),
  /** 取消这个连接上正在执行的语句（不等执行返回，立即生效）。能不能用先看 `caps.cancel`。 */
  cancel: (id: string, slot?: string | null) => invoke<void>("db_cancel", { id, slot: slot || null }),
  /** 这个连接用哪个引擎、那个引擎能做什么。 */
  caps: (id: string) => invoke<EngineCaps>("db_caps", { id }),
  more: (id: string, maxRows: number, slot?: string | null) =>
    invoke<MoreResult>("db_more", { id, maxRows, slot: slot || null }),
  tx: (id: string, action: "commit" | "rollback" | "autocommit-on" | "autocommit-off" | "status", slot?: string | null) =>
    invoke<{ tx: TxInfo; alive?: boolean }>("db_tx", { id, action, slot: slot || null }),
  /**
   * 退出前用：primary + 这条连接上所有独立会话槽一起提交/回滚。
   * 前端不知道有哪些槽（那是后端的记账），所以必须由后端枚举。
   */
  txAll: (id: string, action: "commit" | "rollback") => invoke<void>("db_tx_all", { id, action }),

  tables: (id: string) => invoke<{ tables: TableInfo[] }>("db_meta", { id, kind: "tables" }),
  ncNames: (id: string) => invoke<{ names: Record<string, string> }>("db_meta", { id, kind: "ncNames" }),
  columns: (id: string, table: string) =>
    invoke<{ columns: ColumnInfo[] }>("db_meta", { id, kind: "columns", arg: table }),
  indexes: (id: string, table: string) =>
    invoke<{ indexes: IndexInfo[] }>("db_meta", { id, kind: "indexes", arg: table }),
  ddl: (id: string, table: string) => invoke<{ ddl: string }>("db_meta", { id, kind: "ddl", arg: table }),
  /** 非表对象的 DDL。`otype` 走后端白名单（拼进 `get_ddl` 的字面量），认不出就按表处理。 */
  objectDdl: (id: string, name: string, otype: string) =>
    invoke<{ ddl: string; type?: string }>("db_meta", { id, kind: "ddl", arg: name, arg2: otype }),
  /**
   * 非表对象清单（包 / 包体 / 过程 / 函数 / 序列 / 同义词 / 触发器 / 类型）。
   * 来源是 `user_objects`：只列当前账号能改的东西。
   */
  objects: (id: string) => invoke<{ objects: DbObject[]; count: number }>("db_meta", { id, kind: "objects" }),
  /**
   * 库内源码（`user_source`）。序列、同义词这类没有源码的对象 `lines` 为空。
   * 只读：不编辑、不编译、不回写。
   */
  source: (id: string, name: string) =>
    invoke<{ name: string; lines: SourceLine[]; text: string; count: number }>("db_meta", {
      id,
      kind: "source",
      arg: name,
    }),
  explain: (id: string, sql: string) => invoke<{ plan: PlanRow[] }>("db_meta", { id, kind: "explain", arg: sql }),
  /**
   * 会话与锁（只读，不生成也不执行 kill）。
   * 锁信息读不到时 `granted: false` —— 界面必须显示「缺授权」，不能显示成「没有锁」。
   */
  sessions: (id: string) => invoke<SessionsResult>("db_meta", { id, kind: "sessions" }),

  schemaCache: (id: string) => invoke<SchemaCacheData | null>("db_schema_cache", { id }),
  schemaSync: (id: string) => invoke<SchemaStatus>("db_schema_sync", { id }),

  /**
   * 退出前问一遍：哪些连接上还有未提交的写入。
   *
   * 只回 `id` 与事务数据，连接名/环境由前端从 `dbStore` 取——后端再抄一份
   * 只会两边不同步。`state: "unknown"` 表示探测超时或连接已断（**不是**干净）。
   */
  pendingTx: async () => (await invoke<{ conns: PendingTxRow[] }>("db_pending_tx")).conns ?? [],
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
