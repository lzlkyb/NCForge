import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ResultTable } from "./ResultTable";
import { friendlyDbError, sameCell, thousands } from "../../lib/db";
import { dbApi, type Cell, type ColumnInfo, type ColumnMeta } from "../../lib/dbApi";
import { confirmProdWrite, ask } from "../../lib/dbConfirm";
import { claimCursor, connOf, rtOf, setTx, type TableTab } from "../../lib/dbStore";
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

  /**
   * 每次查询的序号。慢库上连点两次「下一页」时，第 3 页可能先在、第 2 页后到；
   * 没有这道判定的话页脚写「第 3 页」而表格里是第 2 页的行——此时双击改格子，
   * `updateSql` 用的是**看得见的那一行**的主键，写回的就是另一行。
   */
  const gen = useRef(0);

  const load = useCallback(async () => {
    const my = ++gen.current;
    try {
      claimCursor(tab.connId, null, tab.id);
      const r = await dbApi.exec(tab.connId, pageSql(tab.table.toLowerCase(), q.where, order, q.page), PAGE + 1, 60);
      if (my !== gen.current) return;
      if (r.kind !== "rows") throw new Error("不是查询结果");
      setTx(tab.connId, r.tx);
      setData({ ...stripPage(r.columns, r.rows), ms: r.ms });
      setChanged(new Map());
    } catch (e) {
      if (my !== gen.current) return;
      setData({ error: friendlyDbError(e) });
      setChanged(new Map());
    }
  }, [tab.id, tab.connId, tab.table, q.where, q.page, order]);

  // 等字段（主键）读到再查，否则默认排序会先空后有，多查一次
  useEffect(() => {
    if (cols) void load();
  }, [cols, load]);

  /** 翻页 / 改查询条件 / 重新查询前：有未写回的格子时先问一句，别静默丢。 */
  const confirmDiscard = async (): Promise<boolean> => {
    if (changed.size === 0) return true;
    return ask(
      "丢弃未保存的修改？",
      `当前有 ${changed.size} 个单元格改过但没写回，翻页或改查询条件会丢弃它们。`,
      "丢弃并继续",
      true,
    );
  };

  const navTo = async (next: typeof q) => {
    if (!(await confirmDiscard())) return;
    setQ(next);
  };

  /**
   * 查询按钮。条件一个字都没改时也必须真的重查：同事在库里改了数据，回来点「查询」
   * 什么都不发生的话，用户会以为这个工具在读缓存——而这页原本没有别的刷新入口。
   */
  const apply = () => {
    const next = { where: draft.where, order: draft.order, page: 0 };
    if (next.where === q.where && next.order === q.order && q.page === 0) {
      void (async () => {
        if (await confirmDiscard()) await load();
      })();
      return;
    }
    void navTo(next);
  };
  const page = data && "rows" in data ? data : null;
  const sqls = page ? updateSql(tab.table, page.columns, page.rows, pk, changed) : [];

  const save = async () => {
    if (!page || sqls.length === 0) return;
    if (!(await confirmProdWrite(tab.id, tab.connId, sqls.join(";\n")))) return;
    const auto = rtOf(tab.connId).tx?.autoCommit ?? connOf(tab.connId)?.autoCommit ?? false;
    setSaving(true);
    let done = 0;
    try {
      for (const s of sqls) {
        claimCursor(tab.connId, null, tab.id);
        const r = await dbApi.exec(tab.connId, s, 1, 60);
        setTx(tab.connId, r.tx);
        if (r.kind === "update" && r.updateCount !== 1) throw new Error(`预期更新 1 行，实际 ${r.updateCount} 行：${s}`);
        done++;
      }
      toast(
        auto
          ? `已写回 ${done} 行（自动提交）`
          : `已写回 ${done} 行，尚未提交——用上方事务条提交或回滚`,
        "success",
      );
      setPreview(false);
      await load();
    } catch (e) {
      const prefix = done > 0
        ? auto
          ? `第 ${done + 1} 条写回失败：${friendlyDbError(e)}（前 ${done} 条已自动提交，无法整体回滚）`
          : `第 ${done + 1} 条写回失败：${friendlyDbError(e)}（前 ${done} 条仍在未提交事务里，可回滚）`
        : `写回失败：${friendlyDbError(e)}`;
      toast(prefix, "error");
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
      {data && "error" in data && (
        // 失败不是终点：给一条可点的下一步，而不是只让用户对着错误文字重进页面。
        <div className="dbx-err">
          {data.error}
          <button type="button" className="dbx-lk" style={{ marginLeft: 8 }} onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
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
              if (sameCell(v, page.rows[r][c])) next.delete(`${r}:${c}`);
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
                <button type="button" className="dbx-lk" disabled={q.page === 0} onClick={() => void navTo({ ...q, page: q.page - 1 })}>上一页</button>
                <span>第 {q.page + 1} 页</span>
                <button type="button" className="dbx-lk" disabled={!page.hasNext} onClick={() => void navTo({ ...q, page: q.page + 1 })}>下一页</button>
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
