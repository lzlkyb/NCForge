import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../ui/toast";
import { ResultTable } from "./ResultTable";
import { friendlyDbError, parseDbError, thousands, type DbError } from "../../lib/db";
import { dbApi, type BoundCell, type Cell, type ColumnInfo, type ColumnMeta } from "../../lib/dbApi";
import { ask, reconnectSession } from "../../lib/dbConfirm";
import { claimCursor, connOf, rtOf, setTx, type TableTab } from "../../lib/dbStore";
import { beginOperation, useOperations } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { PAGE, pageSql, tableQuerySql, stripPage } from "../../lib/tableEdit";
import { seekPage, type PageAnchor } from "../../lib/tablePaging";
import { captureResultContext, type ResultExecutionContext } from "../../lib/dbResultContext";
import { useCompareBaseline } from "../../lib/dbCompareState";
import { ResultBaselineSummary } from "./ResultCompare";
import { ResultContextNotice } from "./ResultContextNotice";
import { TableDataFooter } from "./TableDataFooter";

import { TableRelations } from "./TableRelations";
import { TransactionButtons, TxBar, useDbTransaction } from "./TxBar";
import { TableFilterBar } from "./TableFilterBar";
import { ChangeReview } from "./ChangeReview";
import { compileFilter, loadFilter } from "../../lib/dbConditions";
import { optimisticChanges, insertChange, deleteChange, planWriteBack } from "../../lib/dbOptimisticEdit";
import { useRowDrafts } from "../../hooks/useRowDrafts";
import { useTableEdits } from "../../hooks/useTableEdits";
import { useSaveShortcut } from "../../hooks/useSaveShortcut";
import { useTableSave } from "../../hooks/useTableSave";
import { TableEditTools } from "./TableEditTools";
import { TableDataStatus } from "./TableDataStatus";
import { useDbReadOnly } from "../../lib/dbReadOnly";
interface Page {
  columns: ColumnMeta[];
  rows: Cell[][];
  hasNext: boolean;
  ms: number; at:number; sql:string; pageNumber:number; exportSql:string; params:BoundCell[];
  context:ResultExecutionContext;
}

/**
 * 表页·数据：WHERE / ORDER BY + 分页（每页 200 行，默认按主键排）。
 * 双击单元格编辑，改过的格子标黄；「预览 SQL」看将要执行的 update；写回走当前连接的事务模式。
 * 没有主键的表或视图不给编辑入口——定位不到唯一行。
 */
export function TableData({ tab, cols, isView, zh }: { tab: TableTab; cols: ColumnInfo[] | null; isView: boolean; zh: Record<string, string> }) {
  const baseline = useCompareBaseline();
  const pk = useMemo(() => (cols ?? []).filter((c) => c.pk).map((c) => c.name), [cols]);
  const [q, setQ] = useState<{where:string;order:string;params:BoundCell[];page:number} | null>(null);
  const [ui,setUi] = useState({loading:false,conflict:"",preview:false,saving:false,relationRow:null as Cell[]|null, conflictValues:[] as {name:string;before:Cell;current:Cell;after:Cell}[]});
  const {loading,conflict,preview,saving}=ui;
  const setLoading=(loading:boolean)=>setUi(v=>({...v,loading}));
  const setConflict=(conflict:string)=>setUi(v=>({...v,conflict}));
  const setPreview=(preview:boolean)=>setUi(v=>({...v,preview}));
  const setSaving=(saving:boolean)=>setUi(v=>({...v,saving}));
  const readonly = useDbReadOnly(tab.connId);
  const writing = useOperations().some(op => op.key === "db.table.save:" + tab.id && op.endedAt === undefined);
  const transaction = useDbTransaction({connId:tab.connId, blocked:saving || loading || writing, readOnly:readonly});
  const txLocked = !!transaction.active || transaction.lost;
  useEffect(() => {
    if (!cols) return;
    try { setQ({...tab.query ?? compileFilter(loadFilter(tab.connId,tab.table),cols),page:0}); }
    catch { setQ({where:"",order:"",params:[],page:0}); }
  },[cols,tab.connId,tab.table,tab.query]);
  const [data, setData] = useState<Page | { error: string } | null>(null);
  const [connectionError, setConnectionError] = useState<DbError | null>(null);
  const [changed, setChanged] = useState<Map<string, Cell>>(new Map());

  // 新增行 / 待删除行都还在本地，写回时才落库。显示行 = 查询结果 + 新增草稿。
  // 放在这里而不是 `page` 原来那行：`load` 的依赖数组要在初始化之后才能读到 `drafts.reset`。
  const page = data && "rows" in data ? data : null;
  const drafts = useRowDrafts(page?.rows ?? null, page?.columns.length ?? 0);
  // 格子级动作（改一格 / 撤回一格 / 批量粘贴 / 复制整行）收在一处，见 hooks/useTableEdits。
  const edits = useTableEdits({ base: page?.rows.length ?? 0, rows: page?.rows ?? null, setChanged, drafts });
  // 取成独立引用：`load` 的依赖数组里只能放稳定值，放整个 `drafts` 会让每次渲染都重查。
  const resetDrafts = drafts.reset;

  const editable = !isView && pk.length > 0 && readonly === false && !saving && !loading && !connectionError && !txLocked;
  const order = q?.order || pk.map((p) => p.toLowerCase()).join(", ");

  /**
   * 每次查询的序号。慢库上连点两次「下一页」时，第 3 页可能先在、第 2 页后到；
   * 没有这道判定的话页脚写「第 3 页」而表格里是第 2 页的行——此时双击改格子，
   * `updateSql` 用的是**看得见的那一行**的主键，写回的就是另一行。
   */
  const gen = useRef(0);
  const reading = useRef<typeof q>(null);
  const anchor = useRef<PageAnchor | null>(null);

  const load = useCallback(async () => {
    if (!q || reading.current===q) return;
    reading.current=q;
    const my = ++gen.current; setLoading(true);
    const task=beginOperation(dbTaskSpec(`table:${tab.id}:${my}`,"查询表数据",tab.connId,`${tab.table} · 第 ${q.page+1} 页`,connOf(tab.connId)?.name,tab.id));
    try {
      claimCursor(tab.connId, null, tab.id);
      const key = JSON.stringify([tab.connId,tab.table,q.where,q.params,order]);
      const seek = !isView && !q.order && cols?.filter(c=>c.pk).every(c=>c.nullable===false) ? seekPage(tab.table.toLowerCase(),q.where,pk,key,q.page,anchor.current) : null;
      const sql = seek?.sql ?? pageSql(tab.table.toLowerCase(), q.where, order, q.page);
      const context = captureResultContext(tab.connId,connOf(tab.connId),rtOf(tab.connId).currentSchema ?? rtOf(tab.connId).info?.schema,sql);
      const r = await dbApi.execBound(tab.connId, sql, [...q.params,...(seek?.params ?? [])], PAGE + 1, 60);
      if (my !== gen.current) {task?.finish("cancelled","已被后续查询取代");return;}
      if (r.kind !== "rows") throw new Error("不是查询结果");
      setTx(tab.connId, r.tx);
      const result = stripPage(r.columns, r.rows);
      if (seek?.reverse) { result.rows.reverse(); result.hasNext = true; }
      anchor.current = {key,page:q.page,columns:result.columns,rows:result.rows};
      setData({ ...result, context, ms: r.ms, at:Date.now(), sql, pageNumber:q.page+1, exportSql:tableQuerySql(tab.table.toLowerCase(),q.where,order), params:q.params.map(p=>p && typeof p === "object" ? {...p} : p) });
      setConnectionError(null);
      setChanged(new Map());resetDrafts();
      task?.finish("success",`已读取 ${Math.min(r.rows.length,PAGE)} 行${r.rows.length>PAGE ? "，可继续翻页" : ""}`);
    } catch (e) {
      task?.finish("failed","查询失败，返回数据库页查看详细错误");
      if (my !== gen.current) return;
      const error = parseDbError(e);
      if (error.code === "session-lost" || error.code === "probe-failed") {
        setConnectionError(error);
        return;
      }
      setConnectionError(null);
      setData({ error: friendlyDbError(e) });
      setChanged(new Map());resetDrafts();
    } finally { if(my===gen.current) {reading.current=null;setLoading(false);} }
  }, [tab.id, tab.connId, tab.table, q, order, isView, cols, pk, resetDrafts]);

  // 等字段（主键）读到再查，否则默认排序会先空后有，多查一次
  useEffect(() => {
    if (cols && q) void load();
  }, [cols, q, load]);

  /** 翻页 / 改查询条件 / 重新查询前：有未写回的格子时先问一句，别静默丢。 */
  const confirmDiscard = async (): Promise<boolean> => {
    if (changed.size === 0 && drafts.pending === 0) return true;
    return ask(
      "丢弃未保存的修改？",
      `当前有 ${changed.size} 个单元格改过、${drafts.pending} 处行级增删还没写回，翻页或改查询条件会丢弃它们。`,
      "丢弃并继续",
      true,
    );
  };

  const reconnect = async () => {
    setLoading(true);
    try {
      if (await reconnectSession(tab.connId, null)) {
        setConnectionError({ code: "other", message: "已重新连接，请重新读取表数据。" });
      }
    } catch (e) {
      toast(friendlyDbError(e), "error");
    } finally {
      setLoading(false);
    }
  };

  const navTo = async (next: NonNullable<typeof q>) => {
    if (!(await confirmDiscard())) return;
    setLoading(true); setQ(next);
  };

  /**
   * 查询按钮。条件一个字都没改时也必须真的重查：同事在库里改了数据，回来点「查询」
   * 什么都不发生的话，用户会以为这个工具在读缓存——而这页原本没有别的刷新入口。
   */
  const apply = (where:string,order:string,params:BoundCell[]) => {
    const next = {where,order,params,page:0};
    if(JSON.stringify(next) === JSON.stringify(q)) { void (async () => {if(await confirmDiscard()) await load();})(); }
    else void navTo(next);
  };
  const viewRows = drafts.rows ?? [];
  const changes = page ? planWriteBack([
    ...drafts.deleted.map(r => deleteChange(tab.table, page.columns, page.rows[r], pk, r)),
    ...optimisticChanges(tab.table,page.columns,page.rows,pk,changed),
    // 刚点「新增行」还没填任何值时不能生成 insert（会拼出一条没有列名的 SQL）；
    // 这一行在界面上仍然显示，填了第一个值之后才进入待写回清单。
    ...drafts.drafts.flatMap((d, i) => d.values.size ? [insertChange(tab.table, page.columns, d.values, page.rows.length + i)] : []),
  ]) : [];
  const sqls=changes.map(c=>c.sql);

  const save = useTableSave({
    tab, page, pk, cols, changes, sqls, drafts,
    readonly, txLost: transaction.lost,
    onCommitted: change => {
      setChanged(current => { const next = new Map(current); change.cells.forEach(c => next.delete(`${change.row}:${c.column}`)); return next; });
      setData(current => current && "rows" in current
        ? { ...current, rows: current.rows.map((row, i) => i === change.row
          ? row.map((v, c) => change.cells.some(x => x.column === c) ? change.cells.find(x => x.column === c)!.after : v)
          : row) }
        : current);
    },
    setSaving, setPreview, setConflict,
    setConflictValues: value => setUi(current => ({ ...current, conflictValues: value })),
    setConnectionError, load,
  });
  // Ctrl+S = 写回（DBeaver 语义）。没有待写回内容时不接管这个键，免得挡住别处。
  useSaveShortcut(save, editable && changes.length > 0);

  return (
    <>
      {ui.relationRow && page && <TableRelations tab={tab} columns={page.columns} row={ui.relationRow} onClose={()=>setUi(v=>({...v,relationRow:null}))} />}
      {cols && <TableFilterBar connId={tab.connId} table={tab.table} cols={cols} disabled={saving || loading || txLocked} busy={loading}
        transactions={<TransactionButtons transaction={transaction} />} onApply={apply} />}
      <TxBar transaction={transaction} />
      {loading && data && <div className="dbx-read-status" role="status">正在查询，暂保留上一份结果…</div>}
      <TableDataStatus
        conflict={conflict} conflictValues={ui.conflictValues} connectionError={connectionError}
        saving={saving} loading={loading} hasData={!!data} errorText={data && "error" in data ? data.error : null}
        onReloadConflict={() => void (async () => { if (await confirmDiscard()) { setConflict(""); await load(); } })()}
        onReconnect={() => void reconnect()} onRetry={() => void load()}
      />
      {page && <ResultContextNotice tabId={tab.id} context={page.context} />}
      {page && q && (
        <ResultTable
          tabs={baseline ? <ResultBaselineSummary /> : undefined}
          key={`${q.where}|${order}|${q.page}|${page.at}`}
          columns={page.columns}
          rows={viewRows}
          table={tab.table.toLowerCase()}
          layoutKey={`${tab.connId}:${tab.table.toLowerCase()}`}
          snapshot={{source:`${page.context.source} · ${tab.table} · 第 ${page.pageNumber} 页`,schema:page.context.schema,originTabId:tab.id,sql:page.sql,at:page.at,complete:page.pageNumber===1 && !page.hasNext,columns:page.columns,rows:page.rows}}
          connId={tab.connId}
          transferSource={{connId:tab.connId,resultId:`${tab.id}:${page.at}`,tabId:tab.id,sql:page.exportSql,params:page.params,source:page.context.source,schema:page.context.schema,connectionKey:page.context.connectionKey,complete:page.pageNumber===1 && !page.hasNext,table:tab.table,keys:pk,timeoutSec:60}}
          onRelated={row=>setUi(v=>({...v,relationRow:row}))}
          zh={zh}
          meta={<>第 {page.pageNumber} 页 · <b>{thousands(page.rows.length)}</b> 行 · {page.ms} ms</>}
          edit={editable ? {
            canEdit: (c, r) => {
              const col = page.columns[c];
              if (!col || /TIME ZONE/i.test(col.type) || !/^(VARCHAR|NVARCHAR|CHAR|NCHAR|NUMBER|FLOAT|INTEGER|DECIMAL|DATE|TIMESTAMP|CLOB)/i.test(col.type)) return false;
              // 新增行还没进库，主键列必须能填（否则新增记录永远缺主键）；已有行不能改主键。
              return (r !== undefined && r >= page.rows.length) || !pk.includes(col.name);
            },
            changed,
            onEdit: edits.setCell,
            onResetCell: edits.resetCell,
            onEditMany: edits.setCells,
            onCloneRow: (r) => edits.cloneRow(r, page.columns.flatMap((c, i) => pk.includes(c.name) ? [i] : [])),
            rowState: drafts.status,
            isDraftRow: (r) => r >= page.rows.length,
            onDeleteRow: (r) => drafts.removeRow(r),
            onRestoreRow: (r) => drafts.restoreRow(r),
          } : undefined}
          // 只给「结构性」原因：保存中/加载中/tx 锁定也会让 editable 为假，但那不该弹提示。
          blockedHint={
            readonly ? "当前连接是只读模式" :
            isView ? "视图不能直接改数据" :
            pk.length === 0 ? "这张表没有主键，定位不到唯一行" :
            undefined
          }
          tools={
            <TableEditTools
              changed={changes.filter(c => c.kind === "update").length}
              changedCells={changes.filter(c => c.kind === "update").reduce((n, c) => n + c.cells.length, 0)}
              added={changes.filter(c => c.kind === "insert").length}
              deleted={changes.filter(c => c.kind === "delete").length}
              editable={editable}
              saving={saving}
              preview={preview}
              onAdd={() => drafts.add()}
              onUndo={() => { setChanged(new Map()); drafts.reset(); }}
              onTogglePreview={() => setPreview(!preview)}
              onSave={() => void save()}
            />
          }
          foot={
            <>
              {preview && changes.length > 0 && <ChangeReview changes={changes} columns={page.columns} rows={page.rows} pk={pk} disabled={saving} onUndo={change => {
                if (change.kind === "update") setChanged(current => { const next = new Map(current); change.cells.forEach(c => next.delete(`${change.row}:${c.column}`)); return next; });
                else drafts.restoreRow(change.row);
              }} />}
              {preview && sqls.length > 0 && <pre className="dbx-ddl" style={{ flex: "none", maxHeight: 140, borderTop: "1px solid hsl(var(--border))" }}>{changes.map(c=>`${c.sql};\n-- 绑定参数: ${JSON.stringify(c.params)}`).join("\n")}</pre>}
              <TableDataFooter rows={page.rows.length} pageNumber={page.pageNumber} complete={page.pageNumber===1 && !page.hasNext}
                previousDisabled={saving || loading || q.page===0} nextDisabled={saving || loading || !page.hasNext}
                onPrevious={()=>void navTo({...q,page:q.page-1})} onNext={()=>void navTo({...q,page:q.page+1})}
                hint={readonly ? "只读查询模式" : editable ? "双击单元格编辑（主键列不可改）· F4 看完整值" : isView ? "视图只读" : "没有主键，只读（定位不到唯一行）"} />
            </>
          }
        />
      )}
    </>
  );
}
