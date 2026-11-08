import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ResultTable } from "./ResultTable";
import { friendlyDbError, parseDbError, sameCell, thousands, type DbError } from "../../lib/db";
import { dbApi, type BoundCell, type Cell, type ColumnInfo, type ColumnMeta } from "../../lib/dbApi";
import { confirmProdWrite, ask, reconnectSession } from "../../lib/dbConfirm";
import { claimCursor, connOf, rtOf, setTx, setTxNotice, type TableTab } from "../../lib/dbStore";
import { beginOperation, operationActive, useOperations } from "../../lib/operations";
import { dbTaskSpec, dbTxKey } from "../../lib/dbOperations";
import { PAGE, pageSql, tableQuerySql, stripPage } from "../../lib/tableEdit";
import { seekPage, type PageAnchor } from "../../lib/tablePaging";
import { captureResultContext, resultTargetIssue, type ResultExecutionContext } from "../../lib/dbResultContext";
import { useCompareBaseline } from "../../lib/dbCompareState";
import { ResultBaselineSummary } from "./ResultCompare";
import { ResultContextNotice } from "./ResultContextNotice";
import { TableDataFooter } from "./TableDataFooter";

import { TableRelations } from "./TableRelations";
import { TransactionButtons, TxBar, useDbTransaction } from "./TxBar";
import { TableFilterBar } from "./TableFilterBar";
import { ChangeReview } from "./ChangeReview";
import { compileFilter, loadFilter } from "../../lib/dbConditions";
import { optimisticChanges, lookupRow } from "../../lib/dbOptimisticEdit";
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
      setChanged(new Map());
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
      setChanged(new Map());
    } finally { if(my===gen.current) {reading.current=null;setLoading(false);} }
  }, [tab.id, tab.connId, tab.table, q, order, isView, cols, pk]);

  // 等字段（主键）读到再查，否则默认排序会先空后有，多查一次
  useEffect(() => {
    if (cols && q) void load();
  }, [cols, q, load]);

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
  const page = data && "rows" in data ? data : null;
  const changes = page ? optimisticChanges(tab.table,page.columns,page.rows,pk,changed) : [];
  const sqls=changes.map(c=>c.sql);

  const save = async () => {
    if (!page || readonly !== false || sqls.length === 0 || operationActive("db." + dbTxKey(tab.connId)) || transaction.lost) return;
    const issue = resultTargetIssue(page.context,connOf(tab.connId),rtOf(tab.connId).currentSchema ?? rtOf(tab.connId).info?.schema);
    if (issue) { toast(issue,"warning"); return; }
    const task=beginOperation(dbTaskSpec(`table.save:${tab.id}`,"写回表数据",tab.connId,tab.table,connOf(tab.connId)?.name,tab.id));
    if(!task) return;
    if (!(await confirmProdWrite(tab.id, tab.connId, sqls.join(";\n")))) {task.finish("cancelled","未确认写回，未执行写入");return;}
    setTxNotice(tab.connId, null, undefined);
    const auto = rtOf(tab.connId).tx?.autoCommit ?? connOf(tab.connId)?.autoCommit ?? false;
    setSaving(true);
    let done = 0;
    try {
      for (const change of changes) {
        task.update({phase:`写回第 ${done+1} / ${changes.length} 行`,progress:{done,total:changes.length}});
        claimCursor(tab.connId, null, tab.id);
        const r = await dbApi.execBound(tab.connId, change.sql, change.params, 1, 60);
        setTx(tab.connId, r.tx);
        if (r.kind !== "update" || r.updateCount !== 1) {
          const message=`记录 ${change.row+1} 已变化或被删除，原值校验未通过，已停止写回。`;
          setConflict(message);
          try {
            const query=lookupRow(tab.table,page.columns,page.rows[change.row],pk);
            const latest=await dbApi.execBound(tab.connId,query.sql,query.params,2,60);
            if(latest.kind==="rows" && latest.rows.length===1) setUi(v=>({...v,conflictValues:change.cells.map(c=>({name:page.columns[c.column].name,before:c.before,after:c.after,current:latest.rows[0][latest.columns.findIndex(x=>x.name.toUpperCase()===page.columns[c.column].name.toUpperCase())]}))}));
            else setConflict(`${message} 当前主键已找不到唯一记录。`);
          }catch {setConflict(`${message} 当前记录无法读取，可重新查询核对。`);}
          throw new Error(message);
        }
        // Successful rows no longer belong to the retry set, even when a later row conflicts.
        setChanged(current => {const next=new Map(current);change.cells.forEach(c=>next.delete(`${change.row}:${c.column}`));return next;});
        setData(current => current && "rows" in current ? {...current,rows:current.rows.map((row,i)=>i===change.row ? row.map((v,c)=>change.cells.some(x=>x.column===c) ? change.cells.find(x=>x.column===c)!.after : v) : row)} : current);
        done++;
      }
      toast(
        auto
          ? `已写回 ${done} 行（自动提交）`
          : `已写回 ${done} 行，尚未提交——用上方事务条提交或回滚`,
        "success",
      );
      task.finish("success",`已写回 ${done} 行${auto ? "（自动提交）" : "，尚未提交"}`);
      setPreview(false);
      await load();
    } catch (e) {
      const error = parseDbError(e);
      if (error.code === "session-lost" || error.code === "probe-failed") {
        setConnectionError(error);
        task.finish("failed", "写回已停止，请核对连接和事务结果");
        return;
      }
      const prefix = done > 0
        ? auto
          ? `第 ${done + 1} 条写回失败：${friendlyDbError(e)}（前 ${done} 条已自动提交，无法整体回滚）`
          : `第 ${done + 1} 条写回失败：${friendlyDbError(e)}（前 ${done} 条仍在未提交事务里，可回滚）`
        : `写回失败：${friendlyDbError(e)}`;
      task.finish("failed",`写回失败；前 ${done} 行${auto ? "已自动提交" : "仍在未提交事务中"}，返回表页核对`);
      toast(prefix, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {ui.relationRow && page && <TableRelations tab={tab} columns={page.columns} row={ui.relationRow} onClose={()=>setUi(v=>({...v,relationRow:null}))} />}
      {cols && <TableFilterBar connId={tab.connId} table={tab.table} cols={cols} disabled={saving || loading || txLocked} busy={loading}
        transactions={<TransactionButtons transaction={transaction} />} onApply={apply} />}
      <TxBar transaction={transaction} />
      {loading && data && <div className="dbx-read-status" role="status">正在查询，暂保留上一份结果…</div>}
      {conflict && <div className="dbx-err" role="alert">{conflict} <button type="button" className="dbx-btn" disabled={saving || loading} onClick={() => void (async()=> {if(await confirmDiscard()) {setConflict("");await load();}})()}>重新读取并处理冲突</button></div>}
      {conflict && ui.conflictValues.length>0 && <div className="dbx-change-review"><table><thead><tr><th>字段</th><th>读取时原值</th><th>数据库当前值</th><th>拟写入</th></tr></thead><tbody>{ui.conflictValues.map(c=><tr key={c.name}><td>{c.name}</td><td>{String(c.before ?? "NULL")}</td><td>{String(c.current ?? "NULL")}</td><td>{String(c.after ?? "NULL")}</td></tr>)}</tbody></table></div>}
      {connectionError && (
        <div className="dbx-err" role="alert">
          {connectionError.message}
          {connectionError.code === "session-lost" ? (
            <button type="button" className="dbx-btn" disabled={saving || loading} onClick={() => void reconnect()}>重新连接</button>
          ) : (
            <button type="button" className="dbx-btn" disabled={saving || loading} onClick={() => void (async () => {
            if (await confirmDiscard()) await load();
            })()}>重新读取</button>
          )}
        </div>
      )}
      {!data && !connectionError && <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>}
      {data && "error" in data && (
        // 失败不是终点：给一条可点的下一步，而不是只让用户对着错误文字重进页面。
        <div className="dbx-err">
          {data.error}
          <button type="button" className="dbx-lk" style={{ marginLeft: 8 }} disabled={loading} onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {page && <ResultContextNotice tabId={tab.id} context={page.context} />}
      {page && q && (
        <ResultTable
          tabs={baseline ? <ResultBaselineSummary /> : undefined}
          key={`${q.where}|${order}|${q.page}|${page.at}`}
          columns={page.columns}
          rows={page.rows}
          table={tab.table.toLowerCase()}
          layoutKey={`${tab.connId}:${tab.table.toLowerCase()}`}
          snapshot={{source:`${page.context.source} · ${tab.table} · 第 ${page.pageNumber} 页`,schema:page.context.schema,originTabId:tab.id,sql:page.sql,at:page.at,complete:page.pageNumber===1 && !page.hasNext,columns:page.columns,rows:page.rows}}
          connId={tab.connId}
          transferSource={{connId:tab.connId,resultId:`${tab.id}:${page.at}`,tabId:tab.id,sql:page.exportSql,params:page.params,source:page.context.source,schema:page.context.schema,connectionKey:page.context.connectionKey,complete:page.pageNumber===1 && !page.hasNext,table:tab.table,keys:pk,timeoutSec:60}}
          onRelated={row=>setUi(v=>({...v,relationRow:row}))}
          zh={zh}
          meta={<>第 {page.pageNumber} 页 · <b>{thousands(page.rows.length)}</b> 行 · {page.ms} ms</>}
          edit={editable ? {
            canEdit: (c) => !pk.includes(page.columns[c].name) && !/TIME ZONE/i.test(page.columns[c].type) && /^(VARCHAR|NVARCHAR|CHAR|NCHAR|NUMBER|FLOAT|INTEGER|DECIMAL|DATE|TIMESTAMP|CLOB)/i.test(page.columns[c].type),
            changed,
            onEdit: (r, c, v) => {
              const next = new Map(changed);
              if (sameCell(v, page.rows[r][c])) next.delete(`${r}:${c}`);
              else next.set(`${r}:${c}`, v);
              setChanged(next);
            },
          } : undefined}
          tools={changed.size > 0 && (
            <>
              <span className="meta" style={{ color: "hsl(var(--warning-ink))" }}>已改 {changed.size} 格</span>
              <button type="button" className="dbx-btn ghost" disabled={saving} onClick={() => setChanged(new Map())}>撤销改动</button>
              <button type="button" className="dbx-btn ghost" data-on={preview || undefined} disabled={saving} onClick={() => setPreview(!preview)}>复核修改 / SQL</button>
              <button type="button" className="dbx-btn pri" disabled={!editable || !preview || sqls.length === 0} onClick={() => void save()}>
                <Icon name={saving ? "spinner" : "check"} size={12} />
                {saving ? "写回中…" : `写回 ${sqls.length} 行`}
              </button>
            </>
          )}
          foot={
            <>
              {preview && changes.length > 0 && <ChangeReview changes={changes} columns={page.columns} rows={page.rows} pk={pk} disabled={saving} onUndo={key=>setChanged(current=>{const next=new Map(current);next.delete(key);return next;})} />}
              {preview && sqls.length > 0 && <pre className="dbx-ddl" style={{ flex: "none", maxHeight: 140, borderTop: "1px solid hsl(var(--border))" }}>{changes.map(c=>`${c.sql};\n-- 绑定参数: ${JSON.stringify(c.params)}`).join("\n")}</pre>}
              <TableDataFooter rows={page.rows.length} pageNumber={page.pageNumber} complete={page.pageNumber===1 && !page.hasNext}
                previousDisabled={saving || loading || q.page===0} nextDisabled={saving || loading || !page.hasNext}
                onPrevious={()=>void navTo({...q,page:q.page-1})} onNext={()=>void navTo({...q,page:q.page+1})}
                hint={readonly ? "只读查询模式" : editable ? "双击单元格编辑（主键列不可改）" : isView ? "视图只读" : "没有主键，只读（定位不到唯一行）"} />
            </>
          }
        />
      )}
    </>
  );
}
