import { useCallback, useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ResultTable } from "./ResultTable";
import { friendlyDbError, thousands } from "../../lib/db";
import { dbApi, type Cell, type ColumnInfo, type ColumnMeta } from "../../lib/dbApi";
import { confirmProdWrite } from "../../lib/dbConfirm";
import { claimCursor, setTx, type TableTab } from "../../lib/dbStore";
import { PAGE, pageSql, stripPage, updateSql } from "../../lib/tableEdit";

interface Page {
  columns: ColumnMeta[];
  rows: Cell[][];
  hasNext: boolean;
  ms: number;
}

/**
 * 表页·数据：WHERE / ORDER BY + 分页（每页 200 行，默认按主键排）。
 * 双击单元格编辑，改过的格子标黄；「预览 SQL」看将要执行的 update；写回走当前连接的事务模式。
 * 没有主键的表或视图不给编辑入口——定位不到唯一行。
 */
export function TableData({ tab, cols, isView, zh }: { tab: TableTab; cols: ColumnInfo[] | null; isView: boolean; zh: Record<string, string> }) {
  const pk = (cols ?? []).filter((c) => c.pk).map((c) => c.name);
  const [q, setQ] = useState({ where: "", order: "", page: 0 });
  const [draft, setDraft] = useState({ where: "", order: "" });
  const [data, setData] = useState<Page | { error: string } | null>(null);
  const [changed, setChanged] = useState<Map<string, Cell>>(new Map());
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const editable = !isView && pk.length > 0;
  const order = q.order || pk.map((p) => p.toLowerCase()).join(", ");

  const load = useCallback(async () => {
    setData(null);
    try {
      claimCursor(tab.connId, tab.id);
      const r = await dbApi.exec(tab.connId, pageSql(tab.table.toLowerCase(), q.where, order, q.page), PAGE + 1, 60);
      if (r.kind !== "rows") throw new Error("不是查询结果");
      setTx(tab.connId, r.tx);
      setData({ ...stripPage(r.columns, r.rows), ms: r.ms });
    } catch (e) {
      setData({ error: friendlyDbError(e) });
    }
    setChanged(new Map());
  }, [tab.id, tab.connId, tab.table, q.where, q.page, order]);

  // 等字段（主键）读到再查，否则默认排序会先空后有，多查一次
  useEffect(() => {
    if (cols) void load();
  }, [cols, load]);

  const apply = () => setQ({ where: draft.where, order: draft.order, page: 0 });
  const page = data && "rows" in data ? data : null;
  const sqls = page ? updateSql(tab.table, page.columns, page.rows, pk, changed) : [];

  const save = async () => {
    if (!page || sqls.length === 0) return;
    if (!(await confirmProdWrite(tab.id, tab.connId, sqls.join(";\n")))) return;
    setSaving(true);
    let done = 0;
    try {
      for (const s of sqls) {
        claimCursor(tab.connId, tab.id);
        const r = await dbApi.exec(tab.connId, s, 1, 60);
        setTx(tab.connId, r.tx);
        if (r.kind === "update" && r.updateCount !== 1) throw new Error(`预期更新 1 行，实际 ${r.updateCount} 行：${s}`);
        done++;
      }
      toast(`已写回 ${done} 行`, "success");
      setPreview(false);
      await load();
    } catch (e) {
      toast(`第 ${done + 1} 条写回失败：${friendlyDbError(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="dbx-where">
        <span className="kw">WHERE</span>
        <input className="dbx-inp mono" value={draft.where} placeholder="dr = 0 and pk_org = '…'" onChange={(e) => setDraft({ ...draft, where: e.target.value })} onKeyDown={(e) => e.key === "Enter" && apply()} />
        <span className="kw">ORDER BY</span>
        <input className="dbx-inp mono" style={{ maxWidth: 260 }} value={draft.order} placeholder={pk.map((p) => p.toLowerCase()).join(", ") || "字段"} onChange={(e) => setDraft({ ...draft, order: e.target.value })} onKeyDown={(e) => e.key === "Enter" && apply()} />
        <button type="button" className="dbx-btn pri" onClick={apply}>
          <Icon name="play" size={12} />
          查询
        </button>
      </div>
      {!data && <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>}
      {data && "error" in data && <div className="dbx-err">{data.error}</div>}
      {page && (
        <ResultTable
          key={`${q.where}|${order}|${q.page}`}
          columns={page.columns}
          rows={page.rows}
          table={tab.table.toLowerCase()}
          zh={zh}
          meta={<>第 {q.page + 1} 页 · <b>{thousands(page.rows.length)}</b> 行 · {page.ms} ms</>}
          edit={editable ? {
            canEdit: (c) => !pk.includes(page.columns[c].name),
            changed,
            onEdit: (r, c, v) => {
              const next = new Map(changed);
              if (v === page.rows[r][c]) next.delete(`${r}:${c}`);
              else next.set(`${r}:${c}`, v);
              setChanged(next);
            },
          } : undefined}
          tools={editable && changed.size > 0 && (
            <>
              <span className="meta" style={{ color: "hsl(var(--warning-ink))" }}>已改 {changed.size} 格</span>
              <button type="button" className="dbx-btn ghost" onClick={() => setChanged(new Map())}>撤销改动</button>
              <button type="button" className="dbx-btn ghost" data-on={preview || undefined} onClick={() => setPreview(!preview)}>预览 SQL</button>
              <button type="button" className="dbx-btn pri" disabled={saving || sqls.length === 0} onClick={() => void save()}>
                <Icon name="check" size={12} />
                写回 {sqls.length} 行
              </button>
            </>
          )}
          foot={
            <>
              {preview && sqls.length > 0 && <pre className="dbx-ddl" style={{ flex: "none", maxHeight: 140, borderTop: "1px solid hsl(var(--border))" }}>{sqls.join(";\n") + ";"}</pre>}
              <div className="dbx-rfoot">
                <button type="button" className="dbx-lk" disabled={q.page === 0} onClick={() => setQ({ ...q, page: q.page - 1 })}>上一页</button>
                <span>第 {q.page + 1} 页</span>
                <button type="button" className="dbx-lk" disabled={!page.hasNext} onClick={() => setQ({ ...q, page: q.page + 1 })}>下一页</button>
                <span className="dbx-sp" />
                <span>{editable ? "双击单元格编辑（主键列不可改）" : isView ? "视图只读" : "没有主键，只读（定位不到唯一行）"}</span>
              </div>
            </>
          }
        />
      )}
    </>
  );
}
