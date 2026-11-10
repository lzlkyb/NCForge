import { useEffect, useMemo, useReducer } from "react";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { dbApi, type ColumnInfo, type ColumnMeta, type TableInfo } from "../../lib/dbApi";
import { columnsOf, rtOf } from "../../lib/dbStore";
import { friendlyDbError, qualifyTable } from "../../lib/db";

/** 大字段不能做 `=` 比较，不能当定位列。 */
const LOCATOR_BLOCKED = /CLOB|BLOB|RAW|LONG/i;

interface State {
  tables: TableInfo[];
  loading: boolean;
  error: string;
  search: string;
  picked: TableInfo | null;
  info: ColumnInfo[] | null;
  pickError: string;
  keys: string[];
}

const INITIAL: State = { tables: [], loading: false, error: "", search: "", picked: null, info: null, pickError: "", keys: [] };

type Action =
  | { kind: "reset" }
  | { kind: "tables"; tables: TableInfo[] }
  | { kind: "loading"; loading: boolean }
  | { kind: "error"; error: string }
  | { kind: "search"; search: string }
  | { kind: "pick"; picked: TableInfo }
  | { kind: "info"; info: ColumnInfo[]; keys: string[] }
  | { kind: "pickError"; error: string }
  | { kind: "toggle"; key: string };

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "reset": return INITIAL;
    case "tables": return { ...state, tables: action.tables };
    case "loading": return { ...state, loading: action.loading };
    case "error": return { ...state, error: action.error };
    case "search": return { ...state, search: action.search };
    case "pick": return { ...state, picked: action.picked, info: null, pickError: "", keys: [] };
    case "info": return { ...state, info: action.info, keys: action.keys };
    case "pickError": return { ...state, pickError: action.error };
    case "toggle": return {
      ...state,
      keys: state.keys.includes(action.key) ? state.keys.filter(k => k !== action.key) : [...state.keys, action.key],
    };
  }
}

/**
 * 手动指定编辑目标：选基表 + 选定位列。
 *
 * SQL 结构判不出来（JOIN / 子查询 / 没主键）时，不能只说「只读」——
 * DataGrip 让用户自己指基表，DBeaver 让用户选 virtual key。这里合成一个入口：
 * 先选表，再默认勾上结果里齐全的主键；主键不齐或没有主键时让用户自行选列。
 *
 * 只对**当前这条 SQL** 生效（父组件按 sql 清空），不会把上一张表的定位方式带过去。
 */
export function EditTargetDialog({ open, connId, schema, columns, risky, onClose, onApply }: {
  open: boolean;
  connId: string | null;
  schema?: string;
  /** 结果列：用来判断主键是否齐全、提供可选的定位列。 */
  columns: ColumnMeta[];
  /** 原查询是 JOIN/汇总等结构：选表后要额外提醒确认唯一性。 */
  risky: boolean;
  onClose: () => void;
  onApply: (table: string, keys: string[]) => void;
}) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const { tables, loading, error, search, picked, info, pickError, keys } = state;

  useEffect(() => {
    if (!open) return;
    dispatch({ kind: "reset" });
    if (!connId) return;
    const cached = rtOf(connId).tables;
    if (cached?.length) { dispatch({ kind: "tables", tables: cached }); return; }
    dispatch({ kind: "loading", loading: true });
    void dbApi.tables(connId).then(
      r => dispatch({ kind: "tables", tables: r.tables }),
      e => dispatch({ kind: "error", error: friendlyDbError(e) }),
    ).finally(() => dispatch({ kind: "loading", loading: false }));
  }, [open, connId]);

  useEffect(() => {
    if (!open || !picked || !connId) return;
    let alive = true;
    void columnsOf(connId, qualifyTable(schema, picked.name)).then(
      cols => {
        if (!alive) return;
        const present = new Set(columns.map(c => c.name.toUpperCase()));
        const pk = cols.filter(c => c.pk).map(c => c.name.toUpperCase());
        // 主键齐全 → 默认按主键定位；不齐就留给用户自己选。
        dispatch({ kind: "info", info: cols, keys: pk.length && pk.every(n => present.has(n)) ? pk : [] });
      },
      e => { if (alive) dispatch({ kind: "pickError", error: friendlyDbError(e) }); },
    );
    return () => { alive = false; };
  }, [open, picked, connId, schema, columns]);

  const resultNames = useMemo(() => new Set(columns.map(c => c.name.toUpperCase())), [columns]);
  const pk = useMemo(() => (info ?? []).filter(c => c.pk).map(c => c.name.toUpperCase()), [info]);
  const pkReady = pk.length > 0 && pk.every(n => resultNames.has(n));
  const locators = useMemo(() => {
    // 只让真实表列当定位列：结果里的表达式 / 别名列写不进 WHERE。
    const known = info ? new Set(info.map(c => c.name.toUpperCase())) : null;
    return columns.filter(c => !LOCATOR_BLOCKED.test(c.type) && (!known || known.has(c.name.toUpperCase())));
  }, [columns, info]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (q ? tables.filter(t => t.name.toLowerCase().includes(q)) : tables).slice(0, 300);
  }, [tables, search]);

  const apply = () => {
    if (!picked || !keys.length) return;
    onApply(qualifyTable(schema, picked.name), keys);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} ariaLabel="指定基表与定位列">
      <DialogHeader>
        <DialogTitle>指定基表与定位列</DialogTitle>
        <button type="button" className="dbx-btn ghost" onClick={onClose}>关闭</button>
      </DialogHeader>
      {risky && (
        <div className="mb-3 rounded-[var(--r-card)] border border-warning/40 bg-warning/10 p-2 text-xs text-warning-ink">
          原查询是关联/汇总结构。写回只会改你选的那张表；请确认所选定位列能唯一确定结果里的每一行。
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-muted-foreground">1. 选基表</div>
          <input className="dbx-inp sm w-full" value={search} placeholder="搜索表名" aria-label="搜索表名"
            onChange={e => dispatch({ kind: "search", search: e.target.value })} autoFocus />
          {loading && <div className="mt-2 text-xs text-muted-foreground">正在读取表清单…</div>}
          {error && <div className="mt-2 text-xs text-destructive-ink" role="alert">{error}</div>}
          <ul className="mt-2 max-h-64 overflow-auto rounded-[var(--r-card)] border border-border" aria-label="表清单">
            {shown.map(t => (
              <li key={t.name}>
                <button
                  type="button"
                  disabled={t.kind === "VIEW"}
                  title={t.kind === "VIEW" ? "视图不能直接写回" : t.name}
                  onClick={() => dispatch({ kind: "pick", picked: t })}
                  className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-40 ${picked?.name === t.name ? "bg-primary/10 text-primary" : ""}`}
                >
                  <span className="truncate font-mono">{t.name}</span>
                  <span className="ml-2 shrink-0 text-muted-foreground">{t.kind === "VIEW" ? "视图" : "表"}</span>
                </button>
              </li>
            ))}
            {!loading && !error && shown.length === 0 && <li className="px-2 py-3 text-xs text-muted-foreground">没有匹配的表</li>}
          </ul>
        </div>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">2. 选定位列（写回 WHERE 用的列）</div>
          {!picked && <div className="text-xs text-muted-foreground">先选一张表。</div>}
          {picked && !info && !pickError && <div className="text-xs text-muted-foreground">正在读取 {picked.name} 的列…</div>}
          {pickError && <div className="text-xs text-destructive-ink" role="alert">{pickError}</div>}
          {info && (
            <>
              <div className="mb-1 text-xs">
                {pkReady ? <span className="text-success-ink">已自动选主键：{pk.join("、")}</span>
                  : <span className="text-warning-ink">结果里没有完整主键，请手动选能唯一确定一行的列。</span>}
              </div>
              <ul className="max-h-52 overflow-auto rounded-[var(--r-card)] border border-border p-1" aria-label="定位列">
                {locators.map(c => (
                  <li key={c.name}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted">
                      <input type="checkbox" checked={keys.includes(c.name.toUpperCase())}
                        onChange={() => dispatch({ kind: "toggle", key: c.name.toUpperCase() })} />
                      <span className="font-mono">{c.name}</span>
                      <span className="text-muted-foreground">{c.type}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                写回按所选列做等值匹配；若两行值相同，更新会命中多行并被拒绝。大字段不能当定位列。
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="dbx-btn ghost" onClick={onClose}>取消</button>
        <button type="button" className="dbx-btn pri" disabled={!picked || !keys.length} onClick={apply}>
          按所选定位列启用编辑
        </button>
      </div>
    </Dialog>
  );
}
