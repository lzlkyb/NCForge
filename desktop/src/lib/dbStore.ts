import { useCallback, useRef, useSyncExternalStore } from "react";
import { friendlyDbError, parseDbError } from "./db";
import {
  dbApi,
  type Cell,
  type ColumnInfo,
  type ColumnMeta,
  type ConnectInfo,
  type DbConn,
  type EngineCaps,
  type ExecStats,
  type PlanRow,
  type ResultSet,
  type SchemaCacheData,
  type TableInfo,
  type TxInfo,
} from "./dbApi";
import { beginOperation, operationActive, trackOperation } from "./operations";
import { toast } from "../components/ui/toast";
import { dbCancelled, dbTaskSpec, dbTxKey } from "./dbOperations";
import { addHistory } from "./dbHistory";
import { persistentTab, persistentTabsChanged } from "./dbTabPersistence";
import { appendResultRows, fitResult, fitResults, retainedResultBytes, resultBytes, TOTAL_RESULT_BYTES, RESULT_LIMIT_NOTICE } from "./dbResultBudget";
import type { MdDictOut, PickRow, ScopeKind } from "./mdDict";
import { captureResultContext, type ResultExecutionContext } from "./dbResultContext";
import { cloneCompareSnapshot, type CompareTab } from "./dbCompareState";
import { rowsBytes } from "./dbResultBudget";
import type { ResultSnapshot } from "./dbResultTools";
export type { CompareTab } from "./dbCompareState";

/**
 * 数据库页的模块级状态：连接列表、每个连接的运行态、SQL / 表标签页与结果。
 *
 * 放模块级而不是组件 state：切去文件页看代码、再回来继续写 SQL 是核心动线；
 * Java 编辑器里「在数据库中执行」也要能从外面新开一个 SQL 标签。
 * SQL 草稿与标签持久化到 localStorage；结果只在内存里。
 */

export interface ConnRuntime {
  status: "idle" | "connecting" | "connected" | "error";
  info?: ConnectInfo;
  error?: string;
  tx?: TxInfo;
  txNotice?: TxNotice;
  tables?: TableInfo[];
  tablesLoading?: boolean;
  /** 表 / 视图清单读到的时刻。只记成功那次：失败后还标「刚刚」等于骗人。 */
  tablesAt?: number;
  /** NC 表中文名：小写表名 → 显示名。 */
  ncNames?: Record<string, string>;
  /**
   * 这条连接**当前实际生效**的默认 schema（primary 会话的 `sys_context`）。
   *
   * 不是配置里的 `defaultSchema`：用户可能手动切过，配置值那一刻就不准了。界面上
   * 那个胶囊显示的是这个值。
   */
  currentSchema?: string;
  /** 库里能看到的 schema 清单（胶囊下拉用）。连上后读一次，切库时重读。 */
  schemas?: string[];
  schema?: SchemaCacheData | null;
  /**
   * 这个连接实际用的引擎能力（连上后由后端报回来）。
   *
   * 界面上「停止」按钮能不能点、有没有 refcursor 相关入口，都按它决定——
   * 不在前端硬编码「rust 不能停」，那会和后端的实现改动脱节。
   */
  caps?: EngineCaps;
}

export type TxNotice = { kind: "success" | "error" | "lost"; text: string; verify?: boolean };

export interface ResultEntry {
  context?: ResultExecutionContext;
  completedAt?:number;
  startLine?:number;
  id: string;
  /** 第几条语句（脚本执行时）。 */
  index: number;
  sql: string;
  kind: "rows" | "update" | "error";
  columns: ColumnMeta[];
  rows: Cell[][];
  hasMore: boolean;
  /** 多个结果集（`dbms_sql.return_result`）。>1 时结果区给一排小标签。 */
  sets?: ResultSet[];
  updateCount: number;
  autoCommit?: boolean;
  ms: number;
  /** 实际执行开销；`null` / 缺省 = 这个账号读不到 `v$mystat`（界面不显示统计行）。 */
  stats?: ExecStats | null;
  error?: string;
  cancelled?: boolean;
  errorCode?: ReturnType<typeof parseDbError>["code"];
  loadingMore?: boolean;
  moreError?: string;
  moreRetryable?: boolean;
}

export interface OutputLine {
  at: number;
  text: string;
  tone: "info" | "ok" | "bad" | "dbms";
}

export interface SqlTab {
  kind: "sql";
  id: string;
  title: string;
  connId: string | null;
  sql: string;
  maxRows: number;
  timeoutSec: number;
  results: ResultEntry[];
  /** 当前结果标签：结果 id / `plan` / `output`。 */
  view: string | null;
  output: OutputLine[];
  plan: { sql: string; rows: PlanRow[]; error?: string } | null;
  running: boolean;
  executionId?: number;
  /**
   * 这个标签的独立会话槽（A0）。`null` = 还走 primary（还没执行过，或申请失败）。
   *
   * 首次执行时懒申请：多数标签只跑一两条元数据查询，一开标签就占一条会话，
   * 五十个标签就是五十条服务端会话。槽名由后端给（数字字符串）。
   */
  slot?: string | null;
  /** 这个标签所在会话的事务状态。primary 标签不用它（统一看连接的 `rt.tx`）。 */
  tx?: TxInfo;
  txNotice?: TxNotice;
}

export type TableSub = "data" | "struct" | "idx" | "ddl" | "source";

export interface TableTab {
  kind: "table";
  id: string;
  connId: string;
  table: string;
  sub: TableSub;
  /**
   * 非表对象（包/过程/函数/序列/同义词/触发器）的类型，来自 `user_objects.object_type`。
   *
   * 有值 ⇒ 这是「对象页」而不是「表页」：只显示源码与 DDL，不去读字段/索引/数据。
   * 复用 `TableTab` 而不新开一种 tab，是因为关闭、切换、持久化、退出确认这四条链路
   * 都按 `kind` 分派——多一种 kind 就要在四处各加一支，漏一处就是「关不掉的标签」。
   */
  otype?: string;
  query?:{where:string;order:string;params:import("./dbApi").BoundCell[]};
  trail?:{tabId:string;label:string}[];
}

/**
 * 数据字典标签的选表过程与结果。
 *
 * 这些字段原先住在一个独立页签的组件 state 里；并进数据库页后标签会随文档区
 * 切换而卸载，不放进仓库的话「生成一份字典 → 点开 SQL 看一眼 → 回来」就全没了。
 * `data` 可能上百张表、几千列，**只在内存**，不写 localStorage。
 */
export interface DictState {
  mode: ScopeKind;
  /** 勾中的表名（勾选表 / 补丁涉及共用）。 */
  picked: string[];
  prefix: string;
  /** 左栏找表的关键词。 */
  keyword: string;
  /** 补丁模式下核对过库的结果；`null` 且 mode=patch 表示正在核对。 */
  patch: { rows: PickRow[]; missing: string[] } | null;
  data: MdDictOut | null;
  running: boolean;
  error: string | null;
}

/**
 * 数据字典文档标签。
 *
 * `connId` 是建标签时数据库页的当前连接：字典读的是 `md_*` 元数据，多连接时
 * 必须钉住是哪一个库，否则「看的是 A 库的标签、生成的是 B 库的字典」无从察觉。
 */
export interface DictTab {
  kind: "dict";
  id: string;
  connId: string | null;
  title: string;
  state: DictState;
}

export type DbTabItem = SqlTab | TableTab | DictTab | CompareTab;

export const EMPTY_DICT_STATE: DictState = {
  mode: "picked",
  picked: [],
  prefix: "",
  keyword: "",
  patch: null,
  data: null,
  running: false,
  error: null,
};

/** 连接对话框：新建 / 编辑某个连接（`tab` 决定打开哪一页）。 */
export interface ConnDialogState {
  connId: string | null;
  tab: "manual" | "prop" | "file";
}

export interface DbState {
  conns: DbConn[];
  loaded: boolean;
  loadError: string | null;
  rt: Record<string, ConnRuntime>;
  tabs: DbTabItem[];
  active: string | null;
  dialog: ConnDialogState | null;
  /** 会话与锁抽屉（只读面板）。null = 关闭。 */
  sessionPanel: { connId: string } | null;
  objectFinder?:boolean;
}

const TABS_KEY = "ncforge-db-tabs";
export const DEFAULT_MAX_ROWS = 500;
export const DEFAULT_TIMEOUT = 30;

let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

function newSqlTab(connId: string | null, sql: string, title: string): SqlTab {
  return {
    kind: "sql", id: newId("s"), title, connId, sql, maxRows: DEFAULT_MAX_ROWS, timeoutSec: DEFAULT_TIMEOUT,
    results: [], view: null, output: [], plan: null, running: false, slot: null,
  };
}

function loadTabs(): Pick<DbState, "tabs" | "active"> {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return { tabs: [], active: null };
    const v = JSON.parse(raw) as { tabs?: Partial<DbTabItem>[]; active?: string | null };
    const tabs: DbTabItem[] = (v.tabs ?? []).flatMap((t): DbTabItem[] => {
      if (t.kind === "sql" && t.id) {
        const s = t as Partial<SqlTab>;
        return [{ ...newSqlTab(s.connId ?? null, s.sql ?? "", s.title ?? "SQL"), id: s.id!, maxRows: s.maxRows ?? DEFAULT_MAX_ROWS, timeoutSec: s.timeoutSec ?? DEFAULT_TIMEOUT }];
      }
      if (t.kind === "table" && t.id && (t as TableTab).table) return [t as TableTab];
      return [];
    });
    return { tabs, active: tabs.some((t) => t.id === v.active) ? v.active! : tabs[0]?.id ?? null };
  } catch {
    return { tabs: [], active: null };
  }
}

let state: DbState = { conns: [], loaded: false, loadError: null, rt: {}, dialog: null, sessionPanel: null, ...loadTabs() };
const listeners = new Set<() => void>();
const draftListeners = new Map<string, Set<() => void>>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    // 字典标签不落盘：它的 state 里有整份生成的字典（可能几千列），而且重开应用后
    // 也读不到对应连接上的结果，恢复出来只会是个空壳。表标签原样存。
    const tabs = state.tabs.map(persistentTab).filter(t => t !== null);
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active: state.active }));
    } catch {
      // 存不下就算了
    }
  }, 400);
}

function set(patch: Partial<DbState>) {
  const shouldPersist = (patch.active !== undefined && patch.active !== state.active)
    || (patch.tabs !== undefined && persistentTabsChanged(state.tabs, patch.tabs));
  state = { ...state, ...patch };
  if (shouldPersist) persist();
  listeners.forEach((fn) => fn());
}

const subscribeDb = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getDb = () => state;

export function useDb(): DbState {
  return useSyncExternalStore(subscribeDb, () => state);
}

/**
 * 只订阅数据库仓库的一个切片。
 *
 * `useDb()` 给的是整份快照：「某个连接的状态从 connecting 变 connected」会让连接树、
 * SQL 编辑器、结果区、表页一起重渲染。组件一律用本函数或下面的 `useConnRt` 等切片钩子
 * （2026-11-04 起数据库组件已全部改用切片，`useDb` 只留给测试与一次性读取）。
 * 同 `useWorkspaceSelector`：选择器必须返回稳定引用，或自己传 `isEqual`。
 */
export function useDbSelector<T>(
  selector: (s: DbState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const sel = useRef(selector);
  const eq = useRef(isEqual);
  sel.current = selector;
  eq.current = isEqual;
  const memo = useRef<{ has: boolean; value: T } | null>(null);
  const getSelection = useCallback(() => {
    const next = sel.current(state);
    const m = memo.current;
    if (m && m.has && eq.current(m.value, next)) return m.value;
    memo.current = { has: true, value: next };
    return next;
  }, []);
  return useSyncExternalStore(subscribeDb, getSelection, getSelection);
}


// ──────────────────────── 连接 ────────────────────────

export const connOf = (id: string | null | undefined) => state.conns.find((c) => c.id === id) ?? null;
/** 没连过的连接的运行态。用同一个对象：选择器按引用比较，每次 new 会让订阅者无谓重渲染。 */
const IDLE_RT: ConnRuntime = { status: "idle" };
export const rtOf = (id: string | null | undefined): ConnRuntime => (id && state.rt[id]) || IDLE_RT;

// 常用切片。仓库更新都是「只换变了的那一项」（rt[id] / tabs[i] / conns），
// 所以按引用比较就能做到：连接 B 变了，只看连接 A 的组件不重渲染。
export const useConnRt = (id: string | null | undefined) => useDbSelector((s) => (id && s.rt[id]) || IDLE_RT);
export const useConnOf = (id: string | null | undefined) => useDbSelector((s) => s.conns.find((c) => c.id === id) ?? null);
export const useDbConns = () => useDbSelector((s) => s.conns);
/** 各连接运行态的整张表：列表里每行都显示状态的组件用（任一连接变了都要重画）。 */
export const useDbRt = () => useDbSelector((s) => s.rt);
export const useActiveDbTab = () => useDbSelector((s) => s.tabs.find((t) => t.id === s.active) ?? null);

/**
 * 新开控制台 / 数据字典时默认用哪个连接：当前标签的 → 已连上的 → 第一个。
 *
 * 放在仓库层而不是 dbActions：命令面板（App）也要用它开字典标签，而 dbActions
 * 静态引了 sqlModels（含 Monaco），App 不能为了一个默认连接把它拽进首屏。
 */
export function defaultConnId(): string | null {
  const cur = tabOf(state.active)?.connId;
  if (cur && connOf(cur)) return cur;
  return state.conns.find((c) => rtOf(c.id).status === "connected")?.id ?? state.conns[0]?.id ?? null;
}

function setRt(id: string, patch: Partial<ConnRuntime>) {
  set({ rt: { ...state.rt, [id]: { ...rtOf(id), ...patch } } });
}

export function openConnDialog(connId: string | null = null, tab: ConnDialogState["tab"] = "manual") {
  set({ dialog: { connId, tab } });
}

export function closeConnDialog() {
  set({ dialog: null });
}

/**
 * 会话与锁抽屉：打开时记下是哪个连接，抽屉自己按 `connId` 轮询。
 *
 * 为什么放在 store 而不是组件本地状态：按钮在 SQL 工具栏、抽屉挂在数据库页级别，
 * 两者不在同一棵子树里；本地状态只能靠回调层层传。
 */
export function showObjectFinder(open=true) {set({objectFinder:open});}

export function openSessionPanel(connId: string | null) {
  if (!connId) return;
  set({ sessionPanel: { connId } });
}

export function closeSessionPanel() {
  set({ sessionPanel: null });
}

export function setConns(conns: DbConn[]) {
  set({ conns, loaded: true, loadError: null });
}

/**
 * 仅测试用：把整份 store 复位成空状态。
 *
 * 为什么需要：`conns` / `rt` 都是模块级，前一个用例留下的 `rt[id].tx` 会被下一个
 * 用例读到（表现为"莫名多出一条事务"）。`setConns([])` 只清连接表，清不掉 rt。
 */
export function __resetDbForTest() {
  metadataFlights.clear();
  for (const [id, version] of metadataVersions) metadataVersions.set(id, version + 1);
  set({ conns: [], loaded: false, loadError: null, rt: {}, tabs: [], active: null, dialog: null, sessionPanel: null });
}

export async function loadConns(): Promise<void> {
  try {
    setConns(await dbApi.list());
  } catch (e) {
    set({ loaded: true, loadError: friendlyDbError(e) });
  }
}

/** 连库。返回 `need-password` 时界面弹口令框。 */
export async function connect(id: string, password?: string, remember?: boolean): Promise<"ok" | "need-password" | "error"> {
  const requested = sqlTabOf(state.active);
  const prepareSql = requested?.connId === id && !requested.slot;
  setRt(id, { status: "connecting", error: undefined });
  try {
    const info = await trackOperation(dbTaskSpec(`connect:${id}`,"连接数据库",id,"连接",connOf(id)?.name),()=>dbApi.connect(id, password, remember, prepareSql));
    if (info.preparedSlot) {
      const current = requested && sqlTabOf(requested.id);
      const owned = state.tabs.some(t => t.kind === "sql" && t.connId === id && t.slot === info.preparedSlot);
      if (!owned && current?.connId === id && !current.slot) patchTab<SqlTab>(current.id, { slot: info.preparedSlot });
      else if (!owned) void releaseSlot(id, info.preparedSlot);
    }
    // 配置写的是 JVM 桥、本机却没有 Java 运行时：后端已自动改用纯 Rust，
    // 但必须在界面上说出来 —— 否则用户以为自己在用 JVM 桥，撞上 REF CURSOR 时更困惑。
    if (info.engineNote) toast(info.engineNote, "warning");
    setRt(id, { status: "connected", info, currentSchema: info.schema ?? rtOf(id).currentSchema, txNotice: undefined, tx: { autoCommit: info.autoCommit, statements: 0, rows: 0, since: 0 } });
    // 能力位问一次就够（连接期间不会变）；失败不影响已连上的状态，只是按钮按保守处理
    void dbApi.caps(id).then((caps) => setRt(id, { caps })).catch(() => undefined);
    // 查询会话先启动；首次执行复用 trackOperation 的同一申请，不再等元数据抢先排队。
    const active = sqlTabOf(state.active);
    if (active?.connId === id) void ensureSlot(active.id, id).then(() => { if (rtOf(id).status === "connected") void loadMeta(id); });
    else void loadMeta(id);
    if (password && remember !== false) void loadConns();
    return "ok";
  } catch (e) {
    const { code } = parseDbError(e);
    setRt(id, { status: "error", error: friendlyDbError(e) });
    return code === "need-password" || (code === "auth" && connOf(id)?.source === "manual") ? "need-password" : "error";
  }
}

export async function disconnect(id: string): Promise<void> {
  await trackOperation(dbTaskSpec(`disconnect:${id}`,"断开数据库",id,"全部会话",connOf(id)?.name),()=>dbApi.disconnect(id));
  metadataFlights.delete(id);
  metadataVersions.set(id, (metadataVersions.get(id) ?? 0) + 1);
  setRt(id, { status: "idle", info: undefined, tx: undefined, txNotice: undefined, error: undefined, tablesLoading: false });
  // 连接已失效：清掉这条连接上所有标签的执行反馈与旧结果，避免「执行已停止」一直挂着。
  const tabs = state.tabs.map((t) =>
    t.kind === "sql" && t.connId === id
      ? { ...t, executionId: undefined, results: [], plan: null, view: null }
      : t,
  );
  set({ tabs });
}

/** 连上之后拉表清单、NC 中文名、本地表结构缓存（补全用）。任一失败不影响其它。 */
const metadataFlights = new Map<string, { key: string; promise: Promise<void> }>();
const metadataVersions = new Map<string, number>();
export function loadMeta(id: string, observed=false): Promise<void> {
  const conn = connOf(id);
  const key = JSON.stringify([conn?.url, conn?.user, rtOf(id).currentSchema]);
  const existing = metadataFlights.get(id);
  if (existing?.key === key) return existing.promise;
  const version = (metadataVersions.get(id) ?? 0) + 1;
  metadataVersions.set(id, version);
  const promise = fetchMeta(id, observed, () => metadataVersions.get(id) === version).finally(() => {
    if (metadataFlights.get(id)?.promise === promise) metadataFlights.delete(id);
  });
  metadataFlights.set(id, { key, promise });
  return promise;
}

async function fetchMeta(id: string, observed: boolean, current: () => boolean): Promise<void> {
  const publish = (patch: Partial<ConnRuntime>) => { if (current()) setRt(id, patch); };
  const task=observed ? beginOperation(dbTaskSpec(`meta:${id}`,"刷新数据库对象",id,"主会话",connOf(id)?.name)) : null;
  if(observed && !task) return;
  publish({ tablesLoading: true });
  const [t, n, s, sc] = await Promise.allSettled([
    dbApi.tables(id).then(value => { publish({ tablesLoading: false, tablesAt: Date.now(), tables: value.tables }); return value; }),
    dbApi.ncNames(id).then(value => { publish({ ncNames: value.names }); return value; }),
    dbApi.schemaCache(id).then(value => { publish({ schema: value }); return value; }),
    dbApi.schemas(id).then(value => {
      publish({ schemas: value.schemas, currentSchema: value.current });
      const flight = metadataFlights.get(id);
      if (current() && flight) flight.key = JSON.stringify([connOf(id)?.url, connOf(id)?.user, value.current]);
      return value;
    }),
  ]);
  publish({
    tablesLoading: false,
    tablesAt: t.status === "fulfilled" ? Date.now() : rtOf(id).tablesAt,
    tables: t.status === "fulfilled" ? t.value.tables : rtOf(id).tables,
    ncNames: n.status === "fulfilled" ? n.value.names : rtOf(id).ncNames,
    schema: s.status === "fulfilled" ? s.value : rtOf(id).schema,
    schemas: sc.status === "fulfilled" ? sc.value.schemas : rtOf(id).schemas,
    currentSchema: sc.status === "fulfilled" ? sc.value.current : rtOf(id).currentSchema,
  });
  const failed=[t,n,s,sc].filter(r=>r.status==="rejected").length;
  task?.finish(failed ? "failed" : "success",failed ? `有 ${failed} 项未读取成功；已保留可用清单，返回数据库页核对` : "对象清单与缓存已刷新");
}

const colCache = new Map<string, Promise<ColumnInfo[]>>();

/** 单表字段（含 NC 中文名、主键）。按连接 + 表名缓存，失败不缓存。 */
export function columnsOf(id: string, table: string): Promise<ColumnInfo[]> {
  const key = `${id}|${table.toUpperCase()}`;
  let p = colCache.get(key);
  if (!p) {
    p = dbApi.columns(id, table).then((r) => r.columns);
    p.catch(() => colCache.delete(key));
    colCache.set(key, p);
  }
  return p;
}

export function forgetColumns(id: string) {
  for (const k of [...colCache.keys()]) if (k.startsWith(`${id}|`)) colCache.delete(k);
}

/**
 * 切这条连接默认的 schema（Oracle 侧是 `alter session set current_schema`）。
 *
 * 为什么是「连接级」而不是「标签级」：左栏表树走 primary 会话，SQL 执行走标签自己的
 * 槽，两者必须是同一个 schema，否则会出现「树上点开是这张表、执行时 ORA-00942」。
 * 后端会把这条连接上所有活着的会话一起切（见 `db_set_schema`）。
 *
 * 切完必须重拉元数据：表树、对象树都按当前 schema 过滤。列缓存也要清——它按
 * 「连接 + 表名」存，不清就会把 A schema 的字段显示到 B schema 的同名表上。
 */
export async function changeSchema(id: string, schema: string): Promise<string> {
  const r = await trackOperation(
    dbTaskSpec(`schema:${id}`, "切换默认 schema", id, "全部会话", connOf(id)?.name),
    () => dbApi.setSchema(id, schema),
  );
  forgetColumns(id);
  setRt(id, { currentSchema: r.schema });
  void loadMeta(id);
  return r.schema;
}

export function setTx(id: string, tx: TxInfo) {
  setRt(id, { tx });
}

export function setTxNotice(connId: string, slot: string | null | undefined, tabId: string | undefined, notice?: TxNotice) {
  if (!slot) {
    setRt(connId, { txNotice: notice });
    return;
  }
  const tab = sqlTabOf(tabId);
  if (tab && tab.connId === connId && tab.slot === slot) patchTab<SqlTab>(tab.id, { txNotice: notice });
}

/**
 * 切换/提交/回滚事务。`slot` 为空 = primary；带槽时只动那条会话。
 *
 * 返回值必须交回调用方：槽的事务状态存在标签上（`tab.tx`），不在连接的 `rt.tx` 里。
 * 以前这里统一写 `setTx(id, ...)`，槽的事务会被错记到 primary 上，工具条随后读到的
 * 就是另一条会话的模式。primary 的更新仍在这里做，槽由调用方 `patchTab`。
 */
export async function txAction(
  id: string,
  action: "commit" | "rollback" | "autocommit-on" | "autocommit-off",
  slot?: string | null,
): Promise<TxInfo> {
  if (operationActive("db." + dbTxKey(id, slot))) throw new Error("当前会话有事务操作正在进行");
  const label={commit:"提交事务",rollback:"回滚事务","autocommit-on":"开启自动提交","autocommit-off":"关闭自动提交"}[action];
  const r = await trackOperation(dbTaskSpec(dbTxKey(id, slot),label,id,slot ? `独立会话 ${slot}` : "主会话",connOf(id)?.name,slot ? state.tabs.find(t=>t.kind==="sql" && t.connId===id && t.slot===slot)?.id : undefined),()=>dbApi.tx(id, action, slot));
  if (!slot) setTx(id, r.tx);
  return r.tx;
}

// ──────────────────────── 标签页 ────────────────────────

export const tabOf = (id: string | null | undefined) => state.tabs.find((t) => t.id === id) ?? null;
export const sqlTabOf = (id: string | null | undefined) => {
  const t = tabOf(id);
  return t?.kind === "sql" ? t : null;
};

export function openSqlTab(connId: string | null, sql = ""): string {
  const n = state.tabs.filter((t) => t.kind === "sql").length + 1;
  const tab = newSqlTab(connId, sql, `SQL ${n}`);
  set({ tabs: [...state.tabs, tab], active: tab.id });
  return tab.id;
}

/** One comparison document holds two immutable snapshots; replacing it is an explicit comparison action. */
export function openCompareTab(before: ResultSnapshot, after: ResultSnapshot): string {
  const existing = state.tabs.find(t => t.kind === "compare");
  if (retainedResultBytes(state.tabs, existing?.id) + rowsBytes(before.rows) + rowsBytes(after.rows) > TOTAL_RESULT_BYTES) {
    throw new Error("结果工作台内存不足以保留两份比较快照，请释放旧查询结果后重试；未截断数据。");
  }
  const tab: CompareTab = { kind:"compare", id:existing?.id ?? newId("compare"), connId:null, title:"结果比对",
    before:cloneCompareSnapshot(before), after:cloneCompareSnapshot(after), keys:[], filter:"all", query:"", onlyChanged:true };
  set({ tabs:existing ? state.tabs.map(t => t.id === existing.id ? tab : t) : [...state.tabs,tab], active:tab.id });
  return tab.id;
}

export function openTableTab(connId: string, table: string, sub: TableSub = "data", otype?: string): string {
  // 同名不同类要分开：本来「包 PKG_X」和「表 PKG_X」可能共存，认 tab 时不能只看名字
  const hit = state.tabs.find(
    (t) =>
      t.kind === "table" &&
      t.connId === connId &&
      t.table.toUpperCase() === table.toUpperCase() &&
      (t.otype ?? "") === (otype ?? ""),
  );
  if (hit) {
    set({ active: hit.id, tabs: state.tabs.map((t) => (t.id === hit.id ? { ...t, sub } as TableTab : t)) });
    return hit.id;
  }
  const tab: TableTab = { kind: "table", id: newId("t"), connId, table: table.toUpperCase(), sub, ...(otype ? { otype } : {}) };
  set({ tabs: [...state.tabs, tab], active: tab.id });
  return tab.id;
}

/**
 * 打开（或激活）数据字典标签。字典只开一个：再点一次入口应该是「回到那份字典」，
 * 而不是又开一份空标签。换了绑定连接时旧结果作废——它属于上一个库。
 */
export function openDictTab(connId: string | null): string {
  const hit = state.tabs.find((t): t is DictTab => t.kind === "dict");
  if (hit) {
    set({ active: hit.id });
    if (hit.connId !== connId) {
      patchTab<DictTab>(hit.id, {
        connId,
        state: { ...EMPTY_DICT_STATE, mode: hit.state.mode, prefix: hit.state.prefix },
      });
    }
    return hit.id;
  }
  const tab: DictTab = { kind: "dict", id: newId("d"), connId, title: "数据字典", state: { ...EMPTY_DICT_STATE } };
  set({ tabs: [...state.tabs, tab], active: tab.id });
  return tab.id;
}

/**
 * 更新字典标签的选表状态。接受函数式更新：连点两下勾选时，两次回调都读仓库里的
 * 最新集合，而不是上一帧渲染闭包里抄来的那份。
 */
export function patchDictTab(
  tabId: string,
  patch: Partial<DictState> | ((s: DictState) => Partial<DictState>),
): void {
  const t = tabOf(tabId);
  if (t?.kind !== "dict") return;
  const next = typeof patch === "function" ? patch(t.state) : patch;
  patchTab<DictTab>(tabId, { state: { ...t.state, ...next } });
}

export function closeTab(id: string) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tabs = state.tabs.filter((t) => t.id !== id);
  const closing = state.tabs[i];
  const origin = closing.kind === "compare" ? [closing.after.originTabId,closing.before.originTabId].find(source => tabs.some(t => t.id === source)) : undefined;
  const active = state.active === id ? origin ?? (tabs[i] ?? tabs[i - 1])?.id ?? null : state.active;
  set({ tabs, active });
}

export function activateTab(id: string) {
  if (state.active !== id) set({ active: id });
}

export function patchTab<T extends DbTabItem>(id: string, patch: Partial<T>) {
  set({ tabs: state.tabs.map((t) => {
    if (t.id !== id) return t;
    const next = { ...t, ...patch } as DbTabItem;
    if (next.kind === "sql" && "results" in patch) next.results = fitResults(next.results, TOTAL_RESULT_BYTES - retainedResultBytes(state.tabs, id));
    return next;
  }) });
}

/**
 * 编辑器每次输入都调：只更新数据并排队持久化，**不通知订阅者**——
 * 否则整个数据库页（含几千行的结果表）会跟着打字重渲染。
 */
export function setSqlDraft(tabId: string, sql: string) {
  state = { ...state, tabs: state.tabs.map((t) => (t.id === tabId && t.kind === "sql" ? { ...t, sql } : t)) };
  draftListeners.get(tabId)?.forEach(listener => listener());
  persist();
}

/** Only provenance notices subscribe to keystrokes; the grid and object tree keep their stable data. */
export function useSqlDraft(tabId: string): string {
  const subscribe = useCallback((listener: () => void) => {
    const group = draftListeners.get(tabId) ?? new Set<() => void>();
    draftListeners.set(tabId, group); group.add(listener);
    const unsubscribe = subscribeDb(listener);
    return () => { unsubscribe(); group.delete(listener); if (!group.size) draftListeners.delete(tabId); };
  }, [tabId]);
  const snapshot = useCallback(() => sqlTabOf(tabId)?.sql ?? "", [tabId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// ──────────────────────── 执行 ────────────────────────

function now(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function appendOutput(tabId: string, lines: OutputLine[]) {
  const t = sqlTabOf(tabId);
  if (t) patchTab<SqlTab>(tabId, { output: [...t.output, ...lines].slice(-2000) });
}

export function summaryOf(r: ResultEntry): string {
  if (r.cancelled) return "已停止";
  if (r.kind === "error") return /ORA-\d{5}/.exec(r.error ?? "")?.[0] ?? "失败";
  if (r.kind === "rows") {
    // 多结果集时报个数（行数按第一个算会让用户以为其它结果集也是这么点）
    if (r.sets && r.sets.length > 1) return `${r.sets.length} 个结果集`;
    return `${r.rows.length}${r.hasMore ? "+" : ""} 行`;
  }
  return r.updateCount >= 0 ? `更新 ${r.updateCount} 行` : "已执行";
}

/**
 * 每个会话只留一个游标，任何一次执行都会把它换掉。记下「游标现在属于谁」，
 * 「加载下 N 行」只对游标的主人开放——否则会把别的标签（如表页）查询的行接到这张结果后面。
 *
 * A0 之后游标是**每个会话槽各一个**，所以键是 `连接#槽`：槽 A 的游标和槽 B 的互不相干。
 */
const cursorOwner = new Map<string, string>();
const cursorKey = (connId: string, slot: string | null | undefined) => `${connId}#${slot ?? ""}`;
export const claimCursor = (connId: string, slot: string | null | undefined, owner: string) =>
  void cursorOwner.set(cursorKey(connId, slot), owner);
export const ownsCursor = (connId: string | null, slot: string | null | undefined, owner: string) =>
  !!connId && cursorOwner.get(cursorKey(connId, slot)) === owner;

/**
 * 标签第一次执行时申请一条独立会话（A0）。返回 `null` = 还是走 primary。
 *
 * 申请失败（槽用满 / 后端不支持）**不让执行失败**：退回 primary 就是老行为，
 * 只是那条标签会跟别的标签排队。这件事要说出来，不能让用户以为是后端卡了。
 */
export async function ensureSlot(tabId: string, connId: string): Promise<string | null> {
  const tab = sqlTabOf(tabId);
  if (!tab || tab.connId !== connId) return null;
  if (tab.slot) return tab.slot;
  try {
    return await trackOperation(dbTaskSpec(`slot:${tabId}`,"申请 SQL 独立会话",connId,`SQL 标签 ${tabId}`,connOf(connId)?.name,tabId),async()=>{
    const {slot}=await dbApi.slotAcquire(connId);
    const current = sqlTabOf(tabId);
    // 申请期间标签可能关闭或换库，不能把旧连接的槽塞进新标签，也不能遗留它。
    if (!current || current.connId !== connId || current.slot !== tab.slot) {
      await releaseSlot(connId, slot);
      return null;
    }
    patchTab<SqlTab>(tabId, { slot, tx: undefined });
    return slot;});
  } catch (e) {
    appendOutput(tabId, [{
      at: Date.now(),
      text: `[${now()}] 没申请到独立会话（这次执行会与其它标签共用主会话）：${friendlyDbError(e)}`,
      tone: "info",
    }]);
    return null;
  }
}

/** 释放标签的槽（关标签 / 换连接时）。失败不抛：断开连接时后端已经把槽一并收掉。 */
export async function releaseSlot(connId: string | null, slot: string | null | undefined): Promise<void> {
  if (!connId || !slot) return;
  cursorOwner.delete(cursorKey(connId, slot));
  try {
    await dbApi.slotRelease(connId, slot);
  } catch {
    // 连接已经断了 / 槽已被回收：都不用再管
  }
}

/**
 * 断开或删除连接后清掉所有标签的槽与槽级事务状态。
 *
 * 不清的后果：标签上还留着 `slot: "1"`，下次执行会打到一条不存在的会话上，
 * 报「会话已回收」——而用户明明刚连上。
 */
export function clearSlots(connId: string): void {
  // 结果一并清掉是有意的：断开 / 删除连接后，槽与游标在后端已经收掉，
  // 留着旧结果会让「加载更多」「转移到表」打到不存在的会话上（报 ORA-01000 那一类），
  // 而把它们标成「已完整」又是对导出数据的谎报。宁可让用户重跑一次。
  const tabs = state.tabs.map((t) =>
    t.kind === "sql" && t.connId === connId
      ? { ...t, slot: null, tx: undefined, txNotice: undefined, executionId: undefined, results: [], plan: null, view: null }
      : t,
  );
  for (const k of [...cursorOwner.keys()]) if (k.startsWith(`${connId}#`)) cursorOwner.delete(k);
  set({ tabs });
}

/** 执行一条语句，结果记进标签、事务状态更新到连接（或标签的槽）、写入历史。不抛异常。 */
export async function execOne(tabId: string, sql: string, index: number, context?: ResultExecutionContext, collectStats = false): Promise<ResultEntry> {
  const tab = sqlTabOf(tabId);
  const identity = context ?? (tab?.connId ? captureResultContext(tab.connId, connOf(tab.connId), rtOf(tab.connId).currentSchema ?? rtOf(tab.connId).info?.schema, sql) : undefined);
  const base = { id: newId("r"), index, sql, context: identity, startLine: identity?.target?.startLine, columns: [], rows: [], hasMore: false, updateCount: -1, ms: 0 };
  if (!tab?.connId) return { ...base, kind: "error", error: "这个标签还没选连接" };
  const connId = tab.connId;
  const t0 = Date.now();
  let entry: ResultEntry;
  try {
    let slot = await ensureSlot(tabId, connId);
    claimCursor(connId, slot, base.id);
    let r;
    try {
      r = await dbApi.exec(connId, sql, tab.maxRows, tab.timeoutSec, slot, collectStats);
    } catch (e) {
      // 槽被空闲回收（10 分钟没动过）：重开一条再试一次，别让用户点一次就看见红字
      if (slot && parseDbError(e).code === "slot-gone") {
        patchTab<SqlTab>(tabId, { slot: null, tx: undefined });
        slot = await ensureSlot(tabId, connId);
        claimCursor(connId, slot, base.id);
        r = await dbApi.exec(connId, sql, tab.maxRows, tab.timeoutSec, slot, collectStats);
      } else {
        throw e;
      }
    }
    // 槽各自独立事务：primary 的结果写回连接，槽的写回标签
    if (slot) patchTab<SqlTab>(tabId, { tx: r.tx });
    else setTx(connId, r.tx);
    entry = r.kind === "rows"
      ? { ...base, completedAt:Date.now(), kind: "rows", columns: r.columns, rows: r.rows, hasMore: r.hasMore, ms: r.ms, sets: r.sets, stats: r.stats }
      : { ...base, kind: "update", updateCount: r.updateCount, autoCommit: r.fallback ? undefined : r.tx.autoCommit, ms: r.ms, stats: r.stats };
    if (r.output.length) appendOutput(tabId, r.output.map((text) => ({ at: Date.now(), text, tone: "dbms" as const })));
    // P0 能力路由：这条语句其实是在 JVM 桥的临时会话上跑的。必须说出来——
    // 那条会话不在下面的事务条管辖范围里，用户若以为「回滚能撤掉它」会出事。
    if (r.fallback) {
      appendOutput(tabId, [{
        at: Date.now(),
        text: `[${now()}] 这条语句改在 JVM 桥的临时会话上执行：${r.fallback.reason}。它不受本连接「事务」条管理（提交 / 回滚只作用于本连接的会话）`,
        tone: "info",
      }]);
    }
  } catch (e) {
    const { code, message } = parseDbError(e);
    if (code === "bridge") setRt(connId, { status: "error", error: message });
    entry = { ...base, kind: "error", error: friendlyDbError(e), errorCode: code, cancelled:dbCancelled(e), ms: Date.now() - t0 };
  }
  entry = fitResult(entry, TOTAL_RESULT_BYTES - retainedResultBytes(state.tabs));
  const clientMs = Date.now() - t0;
  appendOutput(tabId, [{
    at: Date.now(),
    text: `[${now()}] 第 ${index} 条 · ${summaryOf(entry)} · ${entry.ms} ms${clientMs > entry.ms+50 ? ` · 语句调用用时（含会话申请）${clientMs} ms` : ""}${entry.error ? ` · ${entry.error}` : ""}`,
    tone: entry.kind === "error" ? "bad" : "ok",
  }]);
  addHistory(connId, { at: Date.now(), sql, ms: entry.ms, summary: summaryOf(entry), ok: entry.kind !== "error" });
  return entry;
}

/** 「加载下 N 行」：只对最后一次查询有效（每个会话一个游标）。 */
export async function loadMore(tabId: string, resultId: string): Promise<void> {
  const tab = sqlTabOf(tabId);
  const res = tab?.results.find((r) => r.id === resultId);
  if (!tab?.connId || !res || res.moreError && !res.moreRetryable || res.loadingMore || tab.running || !ownsCursor(tab.connId, tab.slot, resultId)) return;
  const upd = (p: Partial<ResultEntry>) => {
    const cur = sqlTabOf(tabId);
    if (cur) patchTab<SqlTab>(tabId, { results: cur.results.map((r) => (r.id === resultId ? { ...r, ...p } : r)) });
  };
  upd({ loadingMore: true, moreError: undefined, moreRetryable: undefined });
  try {
    const m = await trackOperation({...dbTaskSpec(`more:${tabId}:${resultId}`,"加载后续结果",tab.connId,tab.slot ? `独立会话 ${tab.slot}` : "主会话",connOf(tab.connId)?.name,tabId),cancel:()=>dbApi.cancel(tab.connId!,tab.slot),cancelled:dbCancelled},()=>dbApi.more(tab.connId!, tab.maxRows, tab.slot));
    const cur = sqlTabOf(tabId)?.results.find((r) => r.id === resultId);
    // The tab may have closed, switched connection or re-executed during the request.
    if (!cur || sqlTabOf(tabId)?.connId !== tab.connId || !ownsCursor(tab.connId, tab.slot, resultId)) return;
    const appended = appendResultRows(cur.rows, m.rows, TOTAL_RESULT_BYTES - retainedResultBytes(state.tabs) + resultBytes(cur));
    upd({ rows: appended.rows, hasMore: m.hasMore || appended.limited, moreError: appended.limited ? RESULT_LIMIT_NOTICE : undefined, moreRetryable: false, loadingMore: false });
  } catch (e) {
    const expired = ["session-lost", "slot-gone"].includes(parseDbError(e).code);
    const message = expired ? "旧结果游标已失效，已加载的行仍可查看。请重新执行查询。" : friendlyDbError(e);
    upd({ loadingMore: false, moreError: message, moreRetryable: !expired });
    appendOutput(tabId, [{ at: Date.now(), text: `[${now()}] 加载更多失败：${message}`, tone: "bad" }]);
  }
}

export async function explainInto(tabId: string, sql: string): Promise<void> {
  const tab = sqlTabOf(tabId);
  if (!tab?.connId || tab.running) return;
  patchTab<SqlTab>(tabId, { running: true });
  try {
    const r = await trackOperation(dbTaskSpec(`explain:${tabId}`,"读取执行计划",tab.connId,"主会话",connOf(tab.connId)?.name,tabId),()=>dbApi.explain(tab.connId!, sql));
    patchTab<SqlTab>(tabId, { plan: { sql, rows: r.plan }, view: "plan", running: false });
  } catch (e) {
    patchTab<SqlTab>(tabId, { plan: { sql, rows: [], error: friendlyDbError(e) }, view: "plan", running: false });
  }
}
