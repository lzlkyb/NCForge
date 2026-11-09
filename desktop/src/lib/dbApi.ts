import { invoke } from "./tauri";
import type { SchemaStatus } from "./db";
import type { XlsxSheet } from "./xlsxRows";
import type { StructDiff, StructSideReq } from "./dbStructDiff";
import type { TransferEndpoint, TransferPlan, TransferRowsOut } from "./transferPlan";

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
  /**
   * 连上后立刻切到的默认 schema（空串 = 用登录账号自己的）。
   *
   * 切过去之后写 SQL 不用再带 `aier633.` 前缀；它只影响**不带前缀的名字解析**，
   * 不改变权限（查别人 schema 的表仍然要那边给了 SELECT）。
   */
  defaultSchema?: string;
}

/**
 * 执行引擎。**这是连接级属性**，不是全局开关：同一个库同一份 SQL，两条路的资源代价与
 * 能力不一样（见 {@link EngineCaps}），而「要不要解 prop.xml 口令」本身就是连接带来的。
 */
export type DbEngine = "java" | "rust";

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
  /** 默认 schema（空 / 不传 = 不切）。写 SQL 时不用带 `aier633.` 前缀。 */
  defaultSchema?: string | null;
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
  /** 支持按需采集实际统计（逻辑读/物理读）；未采集或账号无权限时 `stats` 为 null。 */
  stats: boolean;
}

/**
 * 一次诊断执行的实际开销（Autotrace）。显式开启时才前后读取 `v$mystat` 取差值。
 *
 * `null` = 未采集或账号读不到统计视图（没有 `V_$MYSTAT` 授权），**不是 0**：
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
  /**
   * 数据库真源（`v$transaction`）的结论，只有点过「核对事务」才有值：
   * true = 确实有未提交事务，false = 确实没有，null = 字典不可读（低权限），
   * undefined = 还没核对（普通 exec 返回的 tx 不带这个字段）。
   */
  active?: boolean | null;
}

export type BoundCell = Cell | {number:string};

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

/**
 * 「这条语句不是在本引擎上跑的」——P0 能力路由的标记。
 *
 * 纯 Rust 引擎跑不了 REF CURSOR 的两种形态（`open :1 for` 的 OUT 绑定、开了游标却不
 * `return_result`），这时后端会把它改到同一连接的 JVM 桥临时会话上执行，并在结果里带上
 * 这一段。**必须显示给用户**：那条会话不归事务条管，不说清楚用户会以为提交/回滚也管着它。
 */
export interface ExecFallback {
  /** 实际执行它的引擎，目前只有 `java`。 */
  engine: string;
  /** 为什么被搬走（后端给的中文原因）。 */
  reason: string;
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
  /** 只在「改走 JVM 桥执行」时出现。 */
  fallback?: ExecFallback;
}

export interface UpdateResult {
  kind: "update";
  /** DML 影响行数；DDL / PL/SQL 块为 -1 或 0。 */
  updateCount: number;
  ms: number;
  stats?: ExecStats | null;
  output: string[];
  tx: TxInfo;
  fallback?: ExecFallback;
}

export type ExecResult = RowsResult | UpdateResult;

export interface MoreResult {
  rows: Cell[][];
  rowCount: number;
  hasMore: boolean;
  ms: number;
}

/**
 * 按需取回来的一格大文本。
 *
 * 结果集里 CLOB 只带预览（前 8K 字符），用户点「加载完整值」才走这条。
 * `truncated` = 到了 1MB 上限还没读完，`value` 仍不是全部。
 */
export interface LobValueOut {
  value: string;
  chars: number;
  truncated: boolean;
  ms: number;
}

/** 导出 insert 脚本的请求：取数语句 + 目标表 + 三条 NC 规则的开关。 */
export interface ExportInsertReq {
  id: string;
  params?: BoundCell[];
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
  /** RAW 列取不到完整值、脚本里只能写 null 的个数（老后端没有这个字段）。 */
  rawNulls?: number;
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
  /** 连上后生效的默认 schema（没设就是登录账号自己的）。 */
  schema?: string;
  /** 默认 schema 没设成时的原因（配置写错 / 没权限）。有值 = 当前用的是登录账号。 */
  schemaWarning?: string | null;
  /** **实际**在用的引擎：配置写 JVM 桥但本机没有运行时，这里会是 `rust`。 */
  engine?: DbEngine;
  /** 被降级时的原因。界面要显示出来，否则用户以为自己在用 JVM 桥。 */
  engineNote?: string | null;
  preparedSlot?: string | null;
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

/** 导入的一列：名字 + 目标列类型（类型决定字面量怎么写：日期要 to_date、数字不加引号）。 */
export interface ImportColReq {
  name: string;
  ty?: string | null;
}

export interface ImportFail {
  /** 文件里的行号（1 起，表头算第 1 行）。 */
  line: number;
  error: string;
}

export interface ImportReq {
  id: string;
  table: string;
  columns: ImportColReq[];
  /** 与 `columns` 等长；`null` 写 NULL。 */
  rows: (string | null)[][];
  startLine?: number;
  /** `true` = 坏行跳过、其余照插；`false` = 遇到第一处错误整批回滚。 */
  skipErrors?: boolean;
}

export interface ImportOut {
  inserted: number;
  failed: ImportFail[];
  truncated: boolean;
  committed: boolean;
  ms: number;
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
  /** 当前默认 schema 下的表数（写错 schema 会掉到 0，一眼能看出）。 */
  tables: number | null;
  /** 连上后生效的默认 schema（空 = 登录账号自己的）。 */
  schema: string;
  /** 默认 schema 没设成的原因。有值 = 当前用的是登录账号。 */
  schemaWarning?: string | null;
  /** 表单选了 JVM 桥但本机没运行时、实际用纯 Rust 测通的原因。 */
  engineNote?: string | null;
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
  /**
   * 数据库真源（`v$transaction`）结论：`false` = 确认没有未提交事务，
   * `null`/缺省 = 没核对或查不了。只有 `false` 才允许推翻界面上的本地计数。
   */
  active?: boolean | null;
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
  /**
   * 这次导出的实例号（前端生成）。取消与进度事件都按它定位，
   * 不传则后端自己取一个，取消就无从下手。一个连接可以同时有好几次导出。
   */
  exportId?: number;
}

export interface ExportFileOut {
  path: string;
  fileName: string;
  rows: number;
  bytes: number;
  /** 到行数上限还有剩余：文件不是全量。 */
  truncated: boolean;
  /** 用户中途取消：文件里是已写入的合法前缀，但不是全量。 */
  canceled: boolean;
  /** 超过全量通道 1M 上限的大文本格子数。>0 说明文件里的长文本不完整（老后端没有这个字段）。 */
  longValues?: number;
  ms: number;
}

/** 导出进度事件（`db:export-progress`）。 */
export interface ExportProgress {
  id: string;
  /** 这次导出的实例号；老后端可能没有。 */
  exportId?: number;
  rows: number;
}

/** 全库按值反查的请求。`mode`：0 包含 / 1 等于 / 2 前缀 / 3 后缀。 */
export interface ValueSearchReq {
  id: string;
  /** 要找的文本（≤200 字符；`%` `_` 按字面量，不是通配符）。 */
  text: string;
  mode: 0 | 1 | 2 | 3;
  /** 只看表名包含这段文字的表（不区分大小写）。 */
  tableFilter?: string | null;
  /** 命中（表 + 列）上限，后端再夹到 1..5000。 */
  maxHits?: number;
  timeoutSec?: number;
  /** 搜索实例号：进度事件与取消都按它定位。 */
  searchId?: number;
}

/** 一条命中：哪张表的哪一列，命中的样本值，以及可直接复制去跑的 SQL。 */
export interface ValueHit {
  table: string;
  column: string;
  sample: string;
  sql: string;
}

export interface ValueSearchOut {
  hits: ValueHit[];
  /** 实际参与搜索的表数（已按表名筛选）。 */
  tablesTotal: number;
  tablesScanned: number;
  /** 名字不安全或类型不可搜索而被跳过的表 / 列。 */
  skippedTables: number;
  skippedColumns: number;
  /** 到命中上限，后面的表没再看。 */
  truncated: boolean;
  canceled: boolean;
  /** 单表失败（权限 / 坏对象 / 超时），不中断整批。 */
  errors: string[];
  /** 没能开独立会话、复用了控制台会话（控制台的「加载更多」会失效）。 */
  sharedSession: boolean;
  ms: number;
}

/** 搜索进度事件（`db:value-search-progress`），每扫完一张表一次。 */
export interface ValueSearchProgress {
  id: string;
  searchId: number;
  phase: "catalog" | "table" | "done";
  done: number;
  total: number;
  table: string | null;
  hits: number;
  errors: number;
}

/** `db_slot_acquire` 的结果：本标签要用的独立会话槽名（数字字符串）。 */
export interface SlotOut {
  slot: string;
}

export const dbApi = {
  relations:(id:string,table:string)=>invoke<{foreign:ExecResult;references:ExecResult;enums?:ExecResult;notes:string[];partial?:boolean;sharedSession:boolean}>("db_relations",{id,table}),
  execBound: (id: string, sql: string, params: BoundCell[], maxRows: number, timeoutSec: number, slot?: string | null) => invoke<ExecResult>("db_exec_bound", {id,sql,params,maxRows,timeoutSec,slot:slot || null}),
  readOnly: (id: string, enabled?: boolean) => invoke<{readOnly:boolean;tx:TxInfo}>("db_read_only", {id,enabled:enabled ?? null}),
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

  connect: (id: string, password?: string, remember?: boolean, prepareSql = false) =>
      invoke<ConnectInfo>("db_connect", { id, password: password || null, remember: remember ?? null, prepareSql }),
  disconnect: (id: string) => invoke<void>("db_disconnect", { id }),
  /**
   * 执行一条语句。`slot` 为空 = primary（元数据 / 表页 / 事务条那条会话）；
   * SQL 标签申请到槽之后，执行、加载更多、取消、事务都必须带同一个槽名。
   */
    exec: (id: string, sql: string, maxRows: number, timeoutSec: number, slot?: string | null, collectStats = false) =>
      invoke<ExecResult>("db_exec", { id, sql, maxRows, timeoutSec, slot: slot || null, collectStats }),
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
  /** 请求停止某一次流式导出（按 `exportId`）；当前页写完后生效，已写入内容保留。 */
  cancelExport: (id: number) => invoke<void>("db_export_cancel", { id }),
  /** 在系统文件管理器里定位刚导出的文件（只允许导出目录内的路径）。 */
  revealExport: (path: string) => invoke<void>("db_export_reveal", { path }),

  /**
   * 全库按值反查（只读）：在一段文本里找所有表的所有文本列。
   * 后端每表发一条查询，进度走 `db:value-search-progress`。
   */
  valueSearch: (req: ValueSearchReq) => invoke<ValueSearchOut>("db_value_search", { req }),
  /** 取消一次按值反查（按 `searchId`）：会打断正在跑的那条查询，不等它超时。 */
  cancelValueSearch: (id: number) => invoke<void>("db_value_search_cancel", { id }),

  /**
   * 导入一批行（B3）。**每次调用自成事务**：全成功才 `commit`，有错且 `skipErrors=false`
   * 就整批回滚。走独立会话，不会把用户自己未提交的改动一起提交。
   */
  importRows: (req: ImportReq) => invoke<ImportOut>("db_import_rows", { req }),
  /**
   * 读 XLSX 的第一张工作表（后端零依赖解析，所有值一律给文本，日期不会变成 1900 序列号）。
   *
   * 字节走 IPC 裸载荷——直接传 `Uint8Array`，**不要**包成 `{ bytes }`：包成对象就退化成
   * JSON 数字数组，一个 5MB 的表要编出几千万个字符，读一次文件就卡几秒。
   */
  readXlsx: (bytes: Uint8Array) => invoke<XlsxSheet>("db_xlsx_read", bytes),
  /**
   * 表结构对比（DDL diff）：两侧各开一条临时只读会话读数据字典，返回差异 + 「把右侧改成
   * 左侧」的 DDL。**只生成脚本，不执行**——改表结构必须由人看过、挑着跑。
   */
  structDiff: (left: StructSideReq, right: StructSideReq) =>
    invoke<StructDiff>("db_struct_diff", { left, right }),
  /** 表 → 表 直连搬运的列映射（只读）：搬之前要把「哪些列搬、哪些不搬」给人看。 */
  transferPlan: (from: TransferEndpoint, to: TransferEndpoint) =>
    invoke<TransferPlan>("db_transfer_plan", { from, to }),
  /**
   * 执行直连搬运：源只读、逐批提交到目标。走 `db:transfer-progress` 事件报进度，
   * `transferId` 用来区分同一次会话里的多次搬运（也可用于取消）。
   */
  transferRows: (req: {
    from: TransferEndpoint;
    to: TransferEndpoint;
    filter?: string | null;
    mode?: "append" | "replace";
    transferId: number;
  }) => invoke<TransferRowsOut>("db_transfer_rows", { req }),
  /** 停止一次搬运：只置标志，当前批写完才停（在飞的 insert 必须知道结果）。 */
  cancelTransferRows: (id: number) => invoke<void>("db_transfer_rows_cancel", { id }),
  /** 取消这个连接上正在执行的语句（不等执行返回，立即生效）。能不能用先看 `caps.cancel`。 */
  cancel: (id: string, slot?: string | null) => invoke<void>("db_cancel", { id, slot: slot || null }),
  /** 这个连接用哪个引擎、那个引擎能做什么。 */
  caps: (id: string) => invoke<EngineCaps>("db_caps", { id }),
  more: (id: string, maxRows: number, slot?: string | null) =>
    invoke<MoreResult>("db_more", { id, maxRows, slot: slot || null }),
  /**
   * 取一格大文本的完整值（网格里只有 8K 预览）。
   *
   * `rowIndex` 是 `rows` 数组下标（不是显示顺序）；`column` 是列名。后端用
   * 「外层编号 + 取第 N 行」重新定位，所以带绑定参数的查询会明确报错。
   */
  lobValue: (id: string, sql: string, rowIndex: number, column: string, slot?: string | null, maxChars?: number) =>
    invoke<LobValueOut>("db_lob_value", { id, sql, rowIndex, column, slot: slot || null, maxChars: maxChars ?? null }),
  tx: (id: string, action: "commit" | "rollback" | "autocommit-on" | "autocommit-off" | "status", slot?: string | null) =>
    invoke<{ tx: TxInfo; alive?: boolean; active?: boolean | null }>("db_tx", { id, action, slot: slot || null }),
  reconnect: (id: string, slot: string | null, password?: string, fallback = false, configured = false) =>
    invoke<{ autoCommit: boolean }>("db_tx", { id, action: configured ? "reconnect-configured" : "reconnect", slot, password, fallback }),
  /**
   * 退出前用：primary + 这条连接上所有独立会话槽一起提交/回滚。
   * 前端不知道有哪些槽（那是后端的记账），所以必须由后端枚举。
   */
  txAll: (id: string, action: "commit" | "rollback") => invoke<void>("db_tx_all", { id, action }),

  tables: (id: string) => invoke<{ tables: TableInfo[] }>("db_meta", { id, kind: "tables" }),
  /**
   * 库里的 schema 清单（`all_users`，任何账号都读得到）+ 当前会话的默认 schema。
   *
   * `current` 是会话的**真实值**（`sys_context`），不是连接配置里的值——用户完全可能
   * 自己发一句 `alter session set current_schema`，配置值那时刻就不准了。
   */
  schemas: (id: string) =>
    invoke<{ schemas: string[]; current: string; user: string }>("db_meta", { id, kind: "schemas" }),
  /**
   * 切这条**会话**的默认 schema（`alter session set current_schema = …`）。
   *
   * `slot` 为空 = primary 会话。每个 SQL 标签本来就是一条独立会话，所以 A 标签切
   * schema 不影响 B。空串 = 回到登录账号自己的 schema。
   */
  setSchema: (id: string, schema: string, slot?: string | null) =>
    invoke<{ schema: string }>("db_set_schema", { id, schema, slot: slot || null }),
  ncNames: (id: string) => invoke<{ names: Record<string, string> }>("db_meta", { id, kind: "ncNames" }),
  /**
   * 一批表的**列**中文名，键是 `表名|列名`（都小写）。
   *
   * 只按表取、不按列名取：`code` / `name` / `id` 这种列名几乎每张表都有，
   * 按列名去重只能随便挑一个，中文名会张冠李戴。不是 NC 库返回空对象（不报错）。
   */
  columnNamesZh: (id: string, tables: string[]) =>
    invoke<{ names: Record<string, string> }>("db_meta", {
      id,
      kind: "columnsZh",
      arg: tables.join(","),
    }),
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

/** 查询快照使用完整连接上下文，避免同名连接的结果被混淆。 */
export function dbSourceOf(conn:DbConn|null):string {
  return conn ? `${conn.name} · ${ENV_LABEL[conn.env]} · ${conn.user}@${dbNameOf(conn.url)}` : "查询结果";
}
