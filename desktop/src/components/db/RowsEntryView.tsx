import { useEffect, useRef, useState } from "react";
import { ResultTable } from "./ResultTable";
import { QuerySettings } from "./QuerySettings";
import { EditBlockedPanel } from "./EditBlockedPanel";
import { EditTargetDialog } from "./EditTargetDialog";
import { useResultSetEdit } from "../../hooks/useResultSetEdit";
import { useSaveShortcut } from "../../hooks/useSaveShortcut";
import { ResultTabList, resultTabId } from "./ResultTabList";
import { ResultContextNotice } from "./ResultContextNotice";
import { thousands } from "../../lib/db";
import { guessTable } from "../../lib/resultExport";
import { statsText, statsTitle } from "../../lib/dbStats";
import { reSortOnServer } from "../../lib/dbResultActions";
import { useColumnZh } from "../../lib/dbColumnZh";
import { isRunning, loadMore, type ResultEntry, type SqlTab } from "../../lib/dbStore";
import { useTxEpoch } from "../../lib/dbTxEpoch";
import { reportEditCount, resultEditKey } from "../../lib/dbDirtyEdits";

/**
 * 有行数据的结果。`dbms_sql.return_result` 可能一次带回多个结果集，
 * 多于一的时候表格上方给一排小标签切换（只有一个就不占那行高度）。
 *
 * 复制导出绑定本次结果来源；隐式结果集只允许导出已读取数据。
 */
export function RowsEntryView({ tab, entry, isLast, onLocate }: { tab: SqlTab; entry: ResultEntry; isLast: boolean; onLocate?:(line:number)=>void }) {
  const [pick, setPick] = useState(0);
  const [diagOpen, setDiagOpen] = useState(false);
  const [pickTarget, setPickTarget] = useState(false);
  const sets = entry.sets ?? [];
  const at = Math.min(pick, Math.max(0, sets.length - 1));
  const set = sets.length > 0 ? sets[at] : null;
  const columns = set?.columns ?? entry.columns;
  const baseRows = set?.rows ?? entry.rows;
  // 隐式结果集也允许改（它同样是单表 SELECT 的结果）；判据全在 editableSource / editableKeys 里。
  // `rows` 由 hook 出来：数据库快照 + 写回成功的本地覆盖 + 新增草稿行。
  const editData = useResultSetEdit({
    tabId: tab.id, connId: tab.connId, slot: tab.slot, sql: entry.sql, columns, rows: baseRows,
    // 写回按执行时的 schema 限定表名：之后切默认 schema 也不会改到同名表的另一份。
    schema: entry.context?.schema,
  });
  const rows = editData.rows;
  // 切结果标签 / 关文档会卸载这个视图，本地改动就没了：把「还有几处没写回」登记出去，
  // 供标签条画圆点、切换与关闭流程先问一句。
  const dirtyCount = editData.dirty ? Math.max(1, editData.count) : 0;
  useEffect(() => {
    reportEditCount(resultEditKey(tab.id, entry.id), dirtyCount);
  }, [tab.id, entry.id, dirtyCount]);
  useEffect(() => () => reportEditCount(resultEditKey(tab.id, entry.id), 0), [tab.id, entry.id]);
  // 同一会话刚回滚过：网格里那些「已写回」的值在库里已经被撤掉，必须提醒重新执行。
  const txEpoch = useTxEpoch(tab.connId, tab.slot);
  const seenTxEpoch = useRef(txEpoch.seq);
  const [staleAfterRollback, setStaleAfterRollback] = useState(false);
  useEffect(() => {
    if (txEpoch.seq === seenTxEpoch.current) return;
    seenTxEpoch.current = txEpoch.seq;
    if (txEpoch.action === "rollback") setStaleAfterRollback(true);
  }, [txEpoch.seq, txEpoch.action]);
  // Ctrl+S = 写回，与表页一致；没有待写回内容时不接管这个键。
  useSaveShortcut(editData.save, !!editData.edit && editData.count > 0, resultEditKey(tab.id, entry.id));
  /** 隐式结果集取到上限还有剩：不能续取，只能调大行数重跑。 */
  const truncated = !!set?.hasMore;
  /** 列名 → NC 中文名。查不到（非 NC 库 / 算出来的列）时表头照旧显示类型。 */
  const zh = useColumnZh(tab.connId, entry.sql, columns);

  const prefix = `dbx-sets-${entry.id}`;
  const complete = sets.length ? !truncated : !entry.hasMore;
  const expired = entry.hasMore && !sets.length && !isLast;
  const multiple = sets.length > 1;

  return (
    <div className="dbx-rset">
      {multiple && <ResultTabList prefix={prefix} label="结果集" items={sets.map((s,i)=>({id:String(i),label:<>结果集 {i+1}<span className="dbx-cnt">已加载 {thousands(s.rows.length)} 行</span></>}))} value={String(at)} onSelect={id=>setPick(Number(id))} />}
      <div className="dbx-result-view" id={multiple ? `${prefix}-panel` : undefined} role={multiple ? "tabpanel" : undefined} tabIndex={multiple ? 0 : undefined} aria-labelledby={multiple ? resultTabId(prefix,String(at)) : undefined}>
      <ResultContextNotice tabId={tab.id} context={entry.context} />
      <ResultTable
        key={at} editOwner={resultEditKey(tab.id, entry.id)}
        settings={<QuerySettings tab={tab} />}
        columns={columns}
        rows={rows}
        table={guessTable(entry.sql)}
        layoutKey={`${tab.connId}:${guessTable(entry.sql) || columns.map(c=>c.name).join("|")}`}
        snapshot={{source:entry.context?.source ?? "执行来源未记录",schema:entry.context?.schema,originTabId:tab.id,sql:entry.sql,at:entry.completedAt ?? entry.context?.startedAt ?? 0,complete,columns,rows}}
        /* 隐式结果集（dbms_sql.return_result）的 SQL 是 PL/SQL 块，按行号外套查询取不到值：
           行号属于子结果集，重跑后外层结果集的行对不上，宁可不给这个入口。 */
        lob={tab.connId && !sets.length ? {connId:tab.connId,slot:tab.slot,sql:entry.sql,timeoutSec:tab.timeoutSec} : undefined}
        meta={
          <>
            {sets.length > 1 && <>第 {at + 1}/{sets.length} 个结果集 · </>}
            {entry.ms} ms
            {entry.context?.target && <span> · 第 {entry.context.target.startLine}–{entry.context.target.endLine ?? entry.context.target.startLine} 行{entry.context.target.editorVersion !== undefined && ` · 编辑版本 ${entry.context.target.editorVersion}`}</span>}
            {statsText(entry.stats) && (
              <>
                {" · "}
                <span className="dbx-stats" title={statsTitle(entry.stats) ?? undefined}>
                  {statsText(entry.stats)}
                </span>
              </>
            )}
          </>
        }
        onServerSort={sets.length ? undefined : (col, dir) => void reSortOnServer(tab.id, entry.sql, columns[col]?.name ?? "", dir, entry.context)}
        transferSource={{connId:entry.context?.connId ?? tab.connId,resultId:`${entry.id}:${at}`,tabId:tab.id,sql:entry.sql,source:entry.context?.source ?? "执行来源未记录",schema:entry.context?.schema,connectionKey:entry.context?.connectionKey,complete,canRequery:!sets.length,timeoutSec:tab.timeoutSec,table:guessTable(entry.sql),sheets:sets.length>1 ? sets.map((s,i)=>({name:`结果集 ${i+1}${s.hasMore ? "-部分" : ""}`,data:{columns:s.columns,rows:s.rows,query:entry.sql}})) : undefined}}
        zh={zh}
        edit={editData.edit}
        // 滚到底自动续取：与底栏「加载下 N 行」同一个入口，条件也一致（隐式结果集 / 失效游标不能续）。
        // 出错时不自动重试——每次滚动都打一次接口只会连环报错，留给底部按钮手动重试。
        // 有未写回改动时不自动续取：追加虽然保得住行号，但仍在编辑时突然插入新行会打断操作，
        // 需要续取请点底栏按钮（同样保留改动）。
        hasMore={entry.hasMore && !sets.length && !expired && !entry.moreError && !editData.dirty}
        loadingMore={entry.loadingMore || isRunning(tab)}
        onLoadMore={() => void loadMore(tab.id, entry.id)}
        // 加载中不提示（「正在确认…」弹出来只是噪音），确定不能改时才说明原因。
        blockedHint={!editData.edit && !editData.blocked.startsWith("正在") ? editData.blockedHint : undefined}
        tools={editData.edit ? (
          <>
            {editData.forced && (
              <button type="button" className="dbx-lk" onClick={editData.clearTarget} title="回到按 SQL 自动判定">
                手动指定 {editData.diagnostics.table ?? ""} · 取消
              </button>
            )}
            {editData.planError && (
              <span className="meta" role="alert" style={{ color: "hsl(var(--destructive-ink))" }} title={editData.planError}>
                {editData.planError}
              </span>
            )}
            {editData.count > 0 ? (
              <>
                <span className="meta" style={{ color: "hsl(var(--warning-ink))" }}>待写回 修改 {editData.count} 条</span>
                <button type="button" className="dbx-btn ghost" disabled={editData.saving} onClick={editData.reset}>撤销改动</button>
                <button type="button" className="dbx-btn pri" disabled={editData.saving} onClick={editData.save}
                  title="按主键写成 UPDATE 并执行 · Ctrl+S">
                  {editData.saving ? "写回中…" : `写回 ${editData.count} 条`}
                </button>
              </>
            ) : editData.planError ? (
              editData.dirty && <button type="button" className="dbx-btn ghost" disabled={editData.saving} onClick={editData.reset}>撤销改动</button>
            ) : <span className="meta" title="双击单元格直接改：Enter 下移、Tab 右移、Esc 取消；也能从 Excel 粘一块进来">可改数据</span>}
          </>
        ) : (
          <>
            <button type="button" className="dbx-lk dbx-edit-status-action" title="查看判定依据与下一步" onClick={() => setDiagOpen(true)}>
              只读 · {editData.blocked}
            </button>
            {tab.connId && !sets.length && !editData.blocked.startsWith("正在") && (
              <button type="button" className="dbx-lk dbx-edit-target-action" onClick={() => setPickTarget(true)}>
                指定基表/定位列…
              </button>
            )}
          </>
        )}
        foot={selection =>
          <div className="dbx-rfoot">
            <strong>已加载 {thousands(rows.length)} 行</strong>
            <span className="dbx-completeness" data-partial={!complete || undefined}>{complete ? "完整结果" : "尚未取完"}</span>
            {entry.moreError && <span role="status">{entry.moreError}</span>}
            {staleAfterRollback && <span role="status" data-stale="1">事务已回滚，结果可能过期 · 重新执行</span>}
            {expired && !entry.moreError && <span role="status">游标已失效，已加载数据仍可查看</span>}
            {(expired || entry.moreError || truncated) && onLocate && <button type="button" className="dbx-lk" onClick={()=>onLocate(entry.startLine ?? 1)}>定位原 SQL</button>}
            {entry.hasMore && (!entry.moreError || entry.moreRetryable) && !sets.length && !expired && (
              <button
                type="button"
                className="dbx-lk"
                disabled={entry.loadingMore || isRunning(tab)}
                onClick={() => void loadMore(tab.id, entry.id)}
              >
                {entry.loadingMore ? "加载中…" : entry.moreRetryable ? "重试加载" : `加载下 ${tab.maxRows} 行`}
              </button>
            )}
            {truncated && (
              <span className="dbx-muted">
                已达读取上限；隐式结果集不能续取，可调整查询设置后重新执行
              </span>
            )}
            <span className="dbx-sp" />
            {selection}
          </div>
        }
      />
      <EditBlockedPanel
        open={diagOpen}
        diag={editData.diagnostics}
        onClose={() => setDiagOpen(false)}
        onPick={tab.connId && !sets.length ? () => { setDiagOpen(false); setPickTarget(true); } : undefined}
      />
      <EditTargetDialog
        open={pickTarget}
        connId={tab.connId}
        schema={entry.context?.schema}
        columns={columns}
        risky={editData.diagnostics.risky}
        onClose={() => setPickTarget(false)}
        onApply={editData.applyTarget}
      />
      </div>
    </div>
  );
}
