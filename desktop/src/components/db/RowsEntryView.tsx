import { useState } from "react";
import { ResultTable } from "./ResultTable";
import { QuerySettings } from "./QuerySettings";
import { useResultSetEdit } from "../../hooks/useResultSetEdit";
import { useSaveShortcut } from "../../hooks/useSaveShortcut";
import type { Cell } from "../../lib/dbApi";
import { ResultTabList, resultTabId } from "./ResultTabList";
import { ResultContextNotice } from "./ResultContextNotice";
import { thousands } from "../../lib/db";
import { guessTable } from "../../lib/resultExport";
import { statsText, statsTitle } from "../../lib/dbStats";
import { reSortOnServer } from "../../lib/dbResultActions";
import { useColumnZh } from "../../lib/dbColumnZh";
import { loadMore, type ResultEntry, type SqlTab } from "../../lib/dbStore";

/**
 * 有行数据的结果。`dbms_sql.return_result` 可能一次带回多个结果集，
 * 多于一的时候表格上方给一排小标签切换（只有一个就不占那行高度）。
 *
 * 复制导出绑定本次结果来源；隐式结果集只允许导出已读取数据。
 */
export function RowsEntryView({ tab, entry, isLast, onLocate }: { tab: SqlTab; entry: ResultEntry; isLast: boolean; onLocate?:(line:number)=>void }) {
  const [pick, setPick] = useState(0);
  const sets = entry.sets ?? [];
  const at = Math.min(pick, Math.max(0, sets.length - 1));
  const set = sets.length > 0 ? sets[at] : null;
  const columns = set?.columns ?? entry.columns;
  const baseRows = set?.rows ?? entry.rows;
  /**
   * 写回成功后的本地行覆盖。结果集是执行当时的一次快照，不回写 store：
   * 否则「再执行一次会看到什么」与屏幕上的内容会静默分叉。
   */
  const [applied, setApplied] = useState<{ from: Cell[][]; rows: Cell[][] } | null>(null);
  const rows = applied && applied.from === baseRows ? applied.rows : baseRows;
  // 隐式结果集也允许改（它同样是单表 SELECT 的结果）；判据全在 editableSource / editableKeys 里。
  const editData = useResultSetEdit({
    tabId: tab.id, connId: tab.connId, slot: tab.slot, sql: entry.sql, columns, rows: baseRows,
    onApplied: updates => setApplied(prev => {
      const next = (prev && prev.from === baseRows ? prev.rows : baseRows).map(r => [...r]);
      for (const { row, col, value } of updates) if (next[row]) next[row][col] = value;
      return { from: baseRows, rows: next };
    }),
  });
  // Ctrl+S = 写回，与表页一致；没有待写回内容时不接管这个键。
  useSaveShortcut(editData.save, !!editData.edit && editData.count > 0);
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
        key={at}
        settings={<QuerySettings tab={tab} />}
        columns={columns}
        rows={rows}
        table={guessTable(entry.sql)}
        layoutKey={`${tab.connId}:${guessTable(entry.sql) || columns.map(c=>c.name).join("|")}`}
        snapshot={{source:entry.context?.source ?? "执行来源未记录",schema:entry.context?.schema,originTabId:tab.id,sql:entry.sql,at:entry.completedAt ?? entry.context?.startedAt ?? 0,complete,columns,rows}}
        lob={tab.connId ? {connId:tab.connId,slot:tab.slot,sql:entry.sql,timeoutSec:tab.timeoutSec} : undefined}
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
        // 加载中不提示（「正在确认…」弹出来只是噪音），确定不能改时才说明原因。
        blockedHint={!editData.edit && !editData.blocked.startsWith("正在") ? editData.blocked : undefined}
        tools={editData.edit ? (
          editData.count > 0 ? (
            <>
              <span className="meta" style={{ color: "hsl(var(--warning-ink))" }}>待写回 修改 {editData.count} 条</span>
              <button type="button" className="dbx-btn ghost" disabled={editData.saving} onClick={editData.reset}>撤销改动</button>
              <button type="button" className="dbx-btn pri" disabled={editData.saving} onClick={editData.save}
                title="按主键写成 UPDATE 并执行 · Ctrl+S">
                {editData.saving ? "写回中…" : `写回 ${editData.count} 条`}
              </button>
            </>
          ) : <span className="meta" title="双击单元格直接改：Enter 下移、Tab 右移、Esc 取消；也能从 Excel 粘一块进来">可改数据</span>
        ) : <span className="meta" title="双击仍可查看完整值">只读 · {editData.blocked}</span>}
        foot={selection =>
          <div className="dbx-rfoot">
            <strong>已加载 {thousands(rows.length)} 行</strong>
            <span className="dbx-completeness" data-partial={!complete || undefined}>{complete ? "完整结果" : "尚未取完"}</span>
            {entry.moreError && <span role="status">{entry.moreError}</span>}
            {expired && !entry.moreError && <span role="status">游标已失效，已加载数据仍可查看</span>}
            {(expired || entry.moreError || truncated) && onLocate && <button type="button" className="dbx-lk" onClick={()=>onLocate(entry.startLine ?? 1)}>定位原 SQL</button>}
            {entry.hasMore && (!entry.moreError || entry.moreRetryable) && !sets.length && !expired && (
              <button
                type="button"
                className="dbx-lk"
                disabled={entry.loadingMore || tab.running}
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
      </div>
    </div>
  );
}
