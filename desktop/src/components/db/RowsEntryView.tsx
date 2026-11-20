import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DbWritebackBar } from "./DbWritebackBar";
import { ResultTable } from "./ResultTable";
import { QuerySettings } from "./QuerySettings";
import { EditBlockedPanel } from "./EditBlockedPanel";
import { EditTargetDialog } from "./EditTargetDialog";
import { DbWritebackDialog } from "./DbWritebackDialog";
import { useResultSetEdit } from "../../hooks/useResultSetEdit";
import { useSaveShortcut } from "../../hooks/useSaveShortcut";
import { ResultTabList, resultTabId } from "./ResultTabList";
import { ResultContextNotice } from "./ResultContextNotice";
import { thousands } from "../../lib/db";
import { guessTable } from "../../lib/resultExport";
import { statsText, statsTitle } from "../../lib/dbStats";
import { appendResultQuery, reSortOnServer, snapshotReplayQuery } from "../../lib/dbResultActions";
import { useColumnZh } from "../../lib/dbColumnZh";
import { connOf, isRunning, loadMore, rtOf, useConnRt, useConnOf, useDbSelector, type ResultEntry, type SqlTab } from "../../lib/dbStore";
import { resultPairOf } from "../../lib/dbResultLayout";
import { resultTargetIssue } from "../../lib/dbResultContext";
import { useTxEpoch } from "../../lib/dbTxEpoch";
import { reportEditCount, resultEditKey } from "../../lib/dbDirtyEdits";
import { useResultDeepDive } from "../../hooks/useResultDeepDive";
import { analyzeSql } from "../../lib/sqlSource";
import { resultFilterQuery, type ResultFollowup } from "../../lib/dbResultFollowup";
import { ResultFollowupDialog, ResultRelationPicker } from "./ResultFollowupDialog";
import { toast } from "../ui/toast";
import type { Cell } from "../../lib/dbApi";
import { querySnippet } from "../../lib/dbSnippets";

/**
 * 有行数据的结果。`dbms_sql.return_result` 可能一次带回多个结果集，
 * 多于一的时候表格上方给一排小标签切换（只有一个就不占那行高度）。
 *
 * 复制导出绑定本次结果来源；隐式结果集只允许导出已读取数据。
 */
type RowsEntryProps = { tab: Pick<SqlTab, "id" | "connId" | "slot" | "run" | "maxRows" | "timeoutSec">; entry: ResultEntry; isLast: boolean; onLocate?:(line:number)=>void; onFillSql?:(sql:string)=>void; onReviewOriginal?:(sql:string)=>void };

export const RowsEntryView = memo(function RowsEntryView(props: RowsEntryProps) {
  const [{ pick, visited }, setSets] = useState({ pick: 0, visited: [0] });
  const sets = props.entry.sets ?? [], at = Math.min(pick, Math.max(0, sets.length - 1));
  const multiple = sets.length > 1, prefix = `dbx-sets-${props.entry.id}`;
  const indices = multiple ? visited.filter(index => index < sets.length) : [0];
  return <div className="dbx-rset">
    {multiple && <ResultTabList prefix={prefix} label="结果集" items={sets.map((s, i) => ({ id: String(i), label: <>结果集 {i+1}<span className="dbx-cnt">已加载 {thousands(s.rows.length)} 行</span></> }))}
      value={String(at)} onSelect={id => {
        const next = Number(id);
        setSets(current => ({ pick: next, visited: current.visited.includes(next) ? current.visited : [...current.visited, next] }));
      }} />}
    {indices.map(index => <div key={index} className="dbx-result-view dbx-result-set-view" hidden={index !== at}
      id={multiple && index === at ? `${prefix}-panel` : undefined} role={multiple ? "tabpanel" : undefined}
      tabIndex={multiple && index === at ? 0 : undefined} aria-labelledby={multiple ? resultTabId(prefix, String(index)) : undefined}>
      <RowsEntrySet {...props} at={index} active={index === at} />
    </div>)}
  </div>;
});

function RowsEntrySet({ tab, entry, isLast, onLocate, onFillSql, onReviewOriginal, at, active }: RowsEntryProps & { at: number; active: boolean }) {
  const [editDialog, setEditDialog] = useState<"diagnostics" | "target" | "preview" | null>(null);
  const [followup, setFollowup] = useState<ResultFollowup | null>(null);
  const [relationRow, setRelationRow] = useState<Cell[] | null>(null);
  const dialogOpen = !!(editDialog || followup || relationRow);
  // Ordinary tab switches only change the parent section's visibility. Re-render the
  // result for focus changes only when a portal needs to follow that visibility.
  const dialogVisible = useDbSelector(state => {
    if (!active || !dialogOpen) return false;
    const live = state.tabs.find(candidate => candidate.id === tab.id);
    if (live?.kind !== "sql") return true;
    if (state.active !== tab.id || live.view === "output" || live.view === "plan") return false;
    const view = live.view ?? live.results[0]?.id;
    return live.resultLayout === "dual"
      ? resultPairOf(live.results.map(result => result.id), live.resultPair, view).includes(entry.id)
      : view === entry.id;
  });
  const openPreview = useCallback(() => setEditDialog("preview"), []);
  const sets = entry.sets ?? [];
  const editOwner = resultEditKey(tab.id, sets.length > 1 ? `${entry.id}:set:${at}` : entry.id);
  const set = sets.length > 0 ? sets[at] : null;
  const columns = set?.columns ?? entry.columns;
  const baseRows = set?.rows ?? entry.rows;
  const snapshotOnly = !!(entry.pinned || entry.archived);
  // 隐式结果集也允许改（它同样是单表 SELECT 的结果）；判据全在 editableSource / editableKeys 里。
  // `rows` 由 hook 出来：数据库快照 + 写回成功的本地覆盖 + 新增草稿行。
  const editData = useResultSetEdit({
    tabId: tab.id, connId: entry.boundQuery || snapshotOnly ? null : tab.connId, slot: tab.slot, sql: entry.sql, columns, rows: baseRows,
    // 写回按执行时的 schema 限定表名：之后切默认 schema 也不会改到同名表的另一份。
    schema: entry.context?.schema,
  });
  const rows = entry.disconnected ? baseRows : editData.rows;
  // 切结果标签 / 关文档会卸载这个视图，本地改动就没了：把「还有几处没写回」登记出去，
  // 供标签条画圆点、切换与关闭流程先问一句。
  const dirtyCount = editData.dirty ? Math.max(1, editData.count) : 0;
  useEffect(() => {
    reportEditCount(editOwner, dirtyCount);
  }, [editOwner, dirtyCount]);
  useEffect(() => () => reportEditCount(editOwner, 0), [editOwner]);
  // 同一会话刚回滚过：网格里那些「已写回」的值在库里已经被撤掉，必须提醒重新执行。
  const txEpoch = useTxEpoch(tab.connId, tab.slot);
  const seenTxEpoch = useRef(txEpoch.seq);
  const [staleAfterRollback, setStaleAfterRollback] = useState(false);
  useEffect(() => {
    if (txEpoch.seq === seenTxEpoch.current) return;
    seenTxEpoch.current = txEpoch.seq;
    if (txEpoch.action === "rollback") setStaleAfterRollback(true);
  }, [txEpoch.seq, txEpoch.action]);
  // Ctrl+S = 打开写回预览（执行前先给人看，与表页同一道闸）；没有待写回内容时不接管这个键。
  useSaveShortcut(openPreview, !snapshotOnly && !!editData.edit && editData.count > 0, editOwner);
  /** 隐式结果集取到上限还有剩：不能续取，只能调大行数重跑。 */
  const truncated = !!set?.hasMore;
  /** 列名 → NC 中文名。查不到（非 NC 库 / 算出来的列）时表头照旧显示类型。 */
  const zh = useColumnZh(tab.connId, entry.sql, columns);
  const table = guessTable(entry.sql);
  const source = useMemo(() => analyzeSql(entry.sql), [entry.sql]);
  const runtime = useConnRt(tab.connId);
  const connection = useConnOf(tab.connId);
  const schema = entry.context?.schema;
  const template = useMemo(() => querySnippet(tab.connId, schema, entry.sql), [tab.connId, schema, entry.sql]);
  const targetIssue = resultTargetIssue(entry.context, connection, runtime.currentSchema ?? runtime.info?.schema);
  const canFollow = !!entry.context && !!tab.connId && !snapshotOnly && !sets.length && !isRunning(tab) && !targetIssue;
  const sameOwner = !source.table?.includes(".") || source.table.split(".")[0].toUpperCase() === schema?.toUpperCase();
  const replay = useMemo(() => entry.disconnected ? snapshotReplayQuery(entry) : null, [entry]);

  /**
   * 「带出子表明细」：查完主表，手里已经有数据，最想顺着关系看子表明细。编辑器侧的
   * 表名 chip 覆盖的是「写 SQL 时」，这里补的是「查完之后」这个时机。
   * 只认**已读到的**关系（与编辑器 chip 同一条规矩）：没读到就整个不显示入口。
   */
  const dive = useResultDeepDive({ connId: snapshotOnly ? null : tab.connId, table, line: entry.startLine ?? 1, onFillSql, onLocate });
  const diveButton = dive.hint ? (
    <button type="button" className="dbx-lk" disabled={dive.busy} onClick={dive.run}
      title={`按已确认的关联生成联查 SQL 填入编辑器（${dive.hint.count} 条关联，最多带出 3 张子表），不自动执行`}>
      {dive.busy ? "正在生成…" : `带出子表明细 · ${dive.hint.count} 条关联`}
    </button>
  ) : null;

  const complete = sets.length ? !truncated : !entry.hasMore;
  const expired = entry.hasMore && !sets.length && (!isLast || !!entry.archived);

  return (
    <>
      <ResultContextNotice tabId={tab.id} context={entry.context} />
      <ResultTable
        editOwner={editOwner}
        settings={<QuerySettings tab={tab} />}
        columns={columns}
        rows={rows}
        table={table}
        layoutKey={`${tab.connId}:${table || columns.map(c=>c.name).join("|")}`}
        templateLayoutKey={template && `template:${JSON.stringify([template.id, tab.connId, schema ?? ""])}`}
        requery={canFollow ? match => {
          const query = resultFilterQuery(entry.sql, columns, match, !!entry.boundQuery);
          if (query) setFollowup(query);
          else toast("此列无法生成数据库筛选条件，可换一个普通字段。", "info");
        } : undefined}
        onRelated={canFollow && source.table && sameOwner ? setRelationRow : undefined}
        snapshot={{source:entry.context?.source ?? "执行来源未记录",schema:entry.context?.schema,originTabId:tab.id,sql:entry.sql,at:entry.completedAt ?? entry.context?.startedAt ?? 0,complete,columns,rows}}
        /* 隐式结果集（dbms_sql.return_result）的 SQL 是 PL/SQL 块，按行号外套查询取不到值：
           行号属于子结果集，重跑后外层结果集的行对不上，宁可不给这个入口。 */
        lob={tab.connId && !snapshotOnly && !sets.length && !entry.boundQuery ? {connId:tab.connId,slot:tab.slot,sql:entry.sql,timeoutSec:tab.timeoutSec, binarySqlForRow: (row, column) => {
          const rt = rtOf(tab.connId);
          return resultTargetIssue(entry.context, connOf(tab.connId), rt.currentSchema ?? rt.info?.schema)
            ? null : editData.binarySqlForRow(row, column);
        }} : undefined}
        meta={
          <>
            {sets.length > 1 && <>第 {at + 1}/{sets.length} 个结果集 · </>}
            {entry.context?.source ?? "执行来源未记录"}
            {entry.context?.schema && <> · {entry.context.schema}</>}
            {entry.completedAt !== undefined && <> · <time dateTime={new Date(entry.completedAt).toISOString()} title={new Date(entry.completedAt).toLocaleString("zh-CN")}>{new Date(entry.completedAt).toLocaleTimeString("zh-CN")}</time></>}
            {entry.context?.target && <span> · 第 {entry.context.target.startLine}–{entry.context.target.endLine ?? entry.context.target.startLine} 行{entry.context.target.editorVersion !== undefined && ` · 编辑版本 ${entry.context.target.editorVersion}`}</span>}
            {statsText(entry.stats) && (
              <>
                {" · "}
                <span className="dbx-stats" title={statsTitle(entry.stats) ?? undefined}>
                  实际执行统计 · {statsText(entry.stats)}
                </span>
              </>
            )}
          </>
        }
        onServerSort={sets.length || entry.boundQuery || entry.archived ? undefined : (col, dir) => void reSortOnServer(tab.id, entry.sql, columns[col]?.name ?? "", dir, entry.context)}
        transferSource={{connId:entry.context?.connId ?? tab.connId,resultId:`${entry.id}:${at}`,tabId:tab.id,sql:entry.sql,source:entry.context?.source ?? "执行来源未记录",schema:entry.context?.schema,connectionKey:entry.context?.connectionKey,complete,canRequery:!sets.length && !entry.boundQuery && !entry.archived,timeoutSec:tab.timeoutSec,table,sheets:sets.length>1 ? sets.map((s,i)=>({name:`结果集 ${i+1}${s.hasMore ? "-部分" : ""}`,data:{columns:s.columns,rows:s.rows,query:entry.sql}})) : undefined}}
        zh={zh}
        edit={snapshotOnly ? undefined : editData.edit}
        // 滚到底自动续取：与底栏「加载下 N 行」同一个入口，条件也一致（隐式结果集 / 失效游标不能续）。
        // 出错时不自动重试——每次滚动都打一次接口只会连环报错，留给底部按钮手动重试。
        // 有未写回改动时不自动续取：追加虽然保得住行号，但仍在编辑时突然插入新行会打断操作，
        // 需要续取请点底栏按钮（同样保留改动）。
        hasMore={entry.hasMore && !sets.length && !expired && !entry.moreError && !editData.dirty}
        loadingMore={entry.loadingMore || isRunning(tab)}
        onLoadMore={() => void loadMore(tab.id, entry.id)}
        // 加载中不提示（「正在确认…」弹出来只是噪音），确定不能改时才说明原因。
        blockedHint={snapshotOnly ? "当前结果是只读快照" : !editData.edit && !editData.blocked.startsWith("正在") ? editData.blockedHint : undefined}
        tools={snapshotOnly ? <span className="dbx-muted">{entry.disconnected ? "连接中断 · 只读快照" : "只读快照"}</span> : editData.edit ? (
          <>
            {editData.forced && (
              <button type="button" className="dbx-lk" onClick={editData.clearTarget} title="回到按 SQL 自动判定">
                手动指定 {editData.diagnostics.table ?? ""} · 取消
              </button>
            )}
            <button type="button" className="dbx-btn ghost" onClick={editData.addRow} title="新增一行空白草稿，写回时插入（没填的列走数据库默认值）">+ 新增行</button>
            {diveButton}

          </>
        ) : (
          <>
            <button type="button" className="dbx-lk dbx-edit-status-action" title={`只读 · ${editData.blocked} · 查看判定依据与下一步`} onClick={() => setEditDialog("diagnostics")}>
              {editData.blocked.startsWith("正在") ? "确认中" : "只读"}
            </button>
            {diveButton}
          </>
        )}
        foot={<>
          <DbWritebackBar count={editData.count} dirty={editData.dirty} error={editData.planError || undefined}
            disabled={!editData.edit} saving={editData.saving} onUndo={editData.reset} onSave={openPreview} />
          <div className="dbx-rfoot">
            <strong>已加载 {thousands(rows.length)} 行</strong>
            <span>{thousands(entry.ms)} ms</span>
            <span className="dbx-completeness" data-partial={!complete || undefined}>{complete ? "完整结果" : expired ? "部分结果" : "尚未取完"}</span>
            {entry.moreError && <span role="status">{entry.moreError}</span>}
            {staleAfterRollback && <span role="status" data-stale="1">事务已回滚，结果可能过期 · 重新执行</span>}
            {expired && !entry.moreError && <span role="status">游标已失效 · 重新执行可刷新结果</span>}
            {entry.disconnected && (replay || onReviewOriginal) && <button type="button" className="dbx-lk" disabled={isRunning(tab)} onClick={() => {
              if (replay) setFollowup(replay);
              else onReviewOriginal?.(entry.sql);
            }}>{replay ? "重新执行查询" : "打开原 SQL"}</button>}
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
          </div>
        </>}
      />
      {dialogVisible && relationRow && tab.connId && <ResultRelationPicker connId={tab.connId} schema={schema} source={source} columns={columns}
        row={relationRow} onClose={() => setRelationRow(null)} onPick={query => { setRelationRow(null); setFollowup(query); }} />}
      {dialogVisible && followup && <ResultFollowupDialog query={followup} target={[entry.context?.source, schema].filter(Boolean).join(" · ")}
        onClose={() => setFollowup(null)} onRun={() => { setFollowup(null); void appendResultQuery(tab.id, entry.id, followup); }} />}
      <EditBlockedPanel
        open={dialogVisible && !snapshotOnly && editDialog === "diagnostics"}
        diag={editData.diagnostics}
        onClose={() => setEditDialog(null)}
        onPick={tab.connId && !sets.length && !editData.blocked.startsWith("正在") ? () => setEditDialog("target") : undefined}
      />
      <EditTargetDialog
        open={dialogVisible && !snapshotOnly && editDialog === "target"}
        connId={tab.connId}
        schema={entry.context?.schema}
        columns={columns}
        risky={editData.diagnostics.risky}
        onClose={() => setEditDialog(null)}
        onApply={editData.applyTarget}
      />
      <DbWritebackDialog
        open={dialogVisible && !snapshotOnly && editDialog === "preview"}
        changes={editData.changes}
        columns={columns}
        rows={rows}
        pk={editData.pk}
        zh={zh}
        saving={editData.saving}
        onUndo={editData.undoChange}
        onUndoAll={editData.reset}
        onSubmit={() => { setEditDialog(null); editData.save(); }}
        onClose={() => setEditDialog(null)}
      />
    </>
  );
}
