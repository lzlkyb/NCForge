import { useSyncExternalStore } from "react";
import { friendlyDbError, parseDbError } from "./db";
import {
  dbApi,
  type Cell,
  type ColumnInfo,
  type ColumnMeta,
  type ConnectInfo,
  type DbConn,
  type PlanRow,
  type SchemaCacheData,
  type TableInfo,
  type TxInfo,
} from "./dbApi";
import { addHistory } from "./dbHistory";

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
  tables?: TableInfo[];
  tablesLoading?: boolean;
  /** NC 表中文名：小写表名 → 显示名。 */
  ncNames?: Record<string, string>;
  schema?: SchemaCacheData | null;
}

export interface ResultEntry {
  id: string;
  /** 第几条语句（脚本执行时）。 */
  index: number;
  sql: string;
  kind: "rows" | "update" | "error";
  columns: ColumnMeta[];
  rows: Cell[][];
  hasMore: boolean;
  updateCount: number;
  ms: number;
  error?: string;
  loadingMore?: boolean;
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
}

export type TableSub = "data" | "struct" | "idx" | "ddl";

export interface TableTab {
  kind: "table";
  id: string;
  connId: string;
  table: string;
  sub: TableSub;
}

export type DbTabItem = SqlTab | TableTab;

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
}

const TABS_KEY = "ncforge-db-tabs";
export const DEFAULT_MAX_ROWS = 500;
export const DEFAULT_TIMEOUT = 30;

let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

function newSqlTab(connId: string | null, sql: string, title: string): SqlTab {
  return {
    kind: "sql", id: newId("s"), title, connId, sql, maxRows: DEFAULT_MAX_ROWS, timeoutSec: DEFAULT_TIMEOUT,
    results: [], view: null, output: [], plan: null, running: false,
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

let state: DbState = { conns: [], loaded: false, loadError: null, rt: {}, dialog: null, ...loadTabs() };
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const tabs = state.tabs.map((t) =>
      t.kind === "sql" ? { kind: t.kind, id: t.id, title: t.title, connId: t.connId, sql: t.sql, maxRows: t.maxRows, timeoutSec: t.timeoutSec } : t,
    );
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active: state.active }));
    } catch {
      // 存不下就算了
    }
  }, 400);
}

function set(patch: Partial<DbState>) {
  state = { ...state, ...patch };
  if ("tabs" in patch || "active" in patch) persist();
  listeners.forEach((fn) => fn());
}

export const getDb = () => state;

export function useDb(): DbState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

// ──────────────────────── 连接 ────────────────────────

export const connOf = (id: string | null | undefined) => state.conns.find((c) => c.id === id) ?? null;
export const rtOf = (id: string | null | undefined): ConnRuntime => (id && state.rt[id]) || { status: "idle" };

function setRt(id: string, patch: Partial<ConnRuntime>) {
  set({ rt: { ...state.rt, [id]: { ...rtOf(id), ...patch } } });
}

export function openConnDialog(connId: string | null = null, tab: ConnDialogState["tab"] = "manual") {
  set({ dialog: { connId, tab } });
}

export function closeConnDialog() {
  set({ dialog: null });
}

export function setConns(conns: DbConn[]) {
  set({ conns, loaded: true, loadError: null });
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
  setRt(id, { status: "connecting", error: undefined });
  try {
    const info = await dbApi.connect(id, password, remember);
    setRt(id, { status: "connected", info, tx: { autoCommit: info.autoCommit, statements: 0, rows: 0, since: 0 } });
    void loadMeta(id);
    if (password && remember !== false) void loadConns();
    return "ok";
  } catch (e) {
    const { code } = parseDbError(e);
    setRt(id, { status: "error", error: friendlyDbError(e) });
    return code === "need-password" || (code === "auth" && connOf(id)?.source === "manual") ? "need-password" : "error";
  }
}

export async function disconnect(id: string): Promise<void> {
  try {
    await dbApi.disconnect(id);
  } finally {
    setRt(id, { status: "idle", info: undefined, tx: undefined, error: undefined });
  }
}

/** 连上之后拉表清单、NC 中文名、本地表结构缓存（补全用）。任一失败不影响其它。 */
export async function loadMeta(id: string): Promise<void> {
  setRt(id, { tablesLoading: true });
  const [t, n, s] = await Promise.allSettled([dbApi.tables(id), dbApi.ncNames(id), dbApi.schemaCache(id)]);
  setRt(id, {
    tablesLoading: false,
    tables: t.status === "fulfilled" ? t.value.tables : rtOf(id).tables,
    ncNames: n.status === "fulfilled" ? n.value.names : rtOf(id).ncNames,
    schema: s.status === "fulfilled" ? s.value : rtOf(id).schema,
  });
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

export function setTx(id: string, tx: TxInfo) {
  setRt(id, { tx });
}

export async function txAction(id: string, action: "commit" | "rollback" | "autocommit-on" | "autocommit-off"): Promise<void> {
  const r = await dbApi.tx(id, action);
  setTx(id, r.tx);
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

export function openTableTab(connId: string, table: string, sub: TableSub = "data"): string {
  const hit = state.tabs.find((t) => t.kind === "table" && t.connId === connId && t.table.toUpperCase() === table.toUpperCase());
  if (hit) {
    set({ active: hit.id, tabs: state.tabs.map((t) => (t.id === hit.id ? { ...t, sub } as TableTab : t)) });
    return hit.id;
  }
  const tab: TableTab = { kind: "table", id: newId("t"), connId, table: table.toUpperCase(), sub };
  set({ tabs: [...state.tabs, tab], active: tab.id });
  return tab.id;
}

export function closeTab(id: string) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tabs = state.tabs.filter((t) => t.id !== id);
  const active = state.active === id ? (tabs[i] ?? tabs[i - 1])?.id ?? null : state.active;
  set({ tabs, active });
}

export function activateTab(id: string) {
  if (state.active !== id) set({ active: id });
}

export function patchTab<T extends DbTabItem>(id: string, patch: Partial<T>) {
  set({ tabs: state.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as DbTabItem) : t)) });
}

/**
 * 编辑器每次输入都调：只更新数据并排队持久化，**不通知订阅者**——
 * 否则整个数据库页（含几千行的结果表）会跟着打字重渲染。
 */
export function setSqlDraft(tabId: string, sql: string) {
  state = { ...state, tabs: state.tabs.map((t) => (t.id === tabId && t.kind === "sql" ? { ...t, sql } : t)) };
  persist();
}

/** 某连接上还开着的标签（删除 / 断开前提示用）。 */
export const tabsOfConn = (connId: string) => state.tabs.filter((t) => t.connId === connId);

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
  if (r.kind === "error") return /ORA-\d{5}/.exec(r.error ?? "")?.[0] ?? "失败";
  if (r.kind === "rows") return `${r.rows.length}${r.hasMore ? "+" : ""} 行`;
  return r.updateCount >= 0 ? `更新 ${r.updateCount} 行` : "已执行";
}

/**
 * 桥里每个连接只留一个游标，任何一次执行都会把它换掉。记下「游标现在属于谁」，
 * 「加载下 N 行」只对游标的主人开放——否则会把别的标签（如表页）查询的行接到这张结果后面。
 */
const cursorOwner = new Map<string, string>();
export const claimCursor = (connId: string, owner: string) => void cursorOwner.set(connId, owner);
export const ownsCursor = (connId: string | null, owner: string) => !!connId && cursorOwner.get(connId) === owner;

/** 执行一条语句，结果记进标签、事务状态更新到连接、写入历史。不抛异常。 */
export async function execOne(tabId: string, sql: string, index: number): Promise<ResultEntry> {
  const tab = sqlTabOf(tabId);
  const base = { id: newId("r"), index, sql, columns: [], rows: [], hasMore: false, updateCount: -1, ms: 0 };
  if (!tab?.connId) return { ...base, kind: "error", error: "这个标签还没选连接" };
  const connId = tab.connId;
  const t0 = Date.now();
  let entry: ResultEntry;
  try {
    claimCursor(connId, base.id);
    const r = await dbApi.exec(connId, sql, tab.maxRows, tab.timeoutSec);
    setTx(connId, r.tx);
    entry = r.kind === "rows"
      ? { ...base, kind: "rows", columns: r.columns, rows: r.rows, hasMore: r.hasMore, ms: r.ms }
      : { ...base, kind: "update", updateCount: r.updateCount, ms: r.ms };
    if (r.output.length) appendOutput(tabId, r.output.map((text) => ({ at: Date.now(), text, tone: "dbms" as const })));
  } catch (e) {
    const { code, message } = parseDbError(e);
    if (code === "bridge") setRt(connId, { status: "error", error: message });
    entry = { ...base, kind: "error", error: friendlyDbError(e), ms: Date.now() - t0 };
  }
  appendOutput(tabId, [{
    at: Date.now(),
    text: `[${now()}] 第 ${index} 条 · ${summaryOf(entry)} · ${entry.ms} ms${entry.error ? ` · ${entry.error}` : ""}`,
    tone: entry.kind === "error" ? "bad" : "ok",
  }]);
  addHistory(connId, { at: Date.now(), sql, ms: entry.ms, summary: summaryOf(entry), ok: entry.kind !== "error" });
  return entry;
}

/** 「加载下 N 行」：只对最后一次查询有效（桥里只留一个游标）。 */
export async function loadMore(tabId: string, resultId: string): Promise<void> {
  const tab = sqlTabOf(tabId);
  const res = tab?.results.find((r) => r.id === resultId);
  if (!tab?.connId || !res || !ownsCursor(tab.connId, resultId)) return;
  const upd = (p: Partial<ResultEntry>) => {
    const cur = sqlTabOf(tabId);
    if (cur) patchTab<SqlTab>(tabId, { results: cur.results.map((r) => (r.id === resultId ? { ...r, ...p } : r)) });
  };
  upd({ loadingMore: true });
  try {
    const m = await dbApi.more(tab.connId, tab.maxRows);
    const cur = sqlTabOf(tabId)?.results.find((r) => r.id === resultId);
    upd({ rows: [...(cur?.rows ?? []), ...m.rows], hasMore: m.hasMore, loadingMore: false });
  } catch (e) {
    upd({ hasMore: false, loadingMore: false });
    appendOutput(tabId, [{ at: Date.now(), text: `[${now()}] 加载更多失败：${friendlyDbError(e)}`, tone: "bad" }]);
  }
}

export async function explainInto(tabId: string, sql: string): Promise<void> {
  const tab = sqlTabOf(tabId);
  if (!tab?.connId) return;
  patchTab<SqlTab>(tabId, { running: true });
  try {
    const r = await dbApi.explain(tab.connId, sql);
    patchTab<SqlTab>(tabId, { plan: { sql, rows: r.plan }, view: "plan", running: false });
  } catch (e) {
    patchTab<SqlTab>(tabId, { plan: { sql, rows: [], error: friendlyDbError(e) }, view: "plan", running: false });
  }
}
