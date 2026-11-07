import { useState, type ReactNode } from "react";
import { ResultTable } from "./ResultTable";
import { QuerySettings } from "./QuerySettings";
import { thousands } from "../../lib/db";
import { guessTable } from "../../lib/resultExport";
import { statsText, statsTitle } from "../../lib/dbStats";
import { dbSourceOf } from "../../lib/dbApi";
import { reSortOnServer } from "../../lib/dbResultActions";
import { useColumnZh } from "../../lib/dbColumnZh";
import { connOf, loadMore, type ResultEntry, type SqlTab } from "../../lib/dbStore";

/**
 * 有行数据的结果。`dbms_sql.return_result` 可能一次带回多个结果集，
 * 多于一的时候表格上方给一排小标签切换（只有一个就不占那行高度）。
 *
 * 复制导出绑定本次结果来源；隐式结果集只允许导出已读取数据。
 */
export function RowsEntryView({ tab, entry, isLast, tabs }: { tab: SqlTab; entry: ResultEntry; isLast: boolean; tabs: ReactNode }) {
  const [pick, setPick] = useState(0);
  const sets = entry.sets ?? [];
  const at = Math.min(pick, Math.max(0, sets.length - 1));
  const set = sets.length > 0 ? sets[at] : null;
  const columns = set?.columns ?? entry.columns;
  const rows = set?.rows ?? entry.rows;
  /** 隐式结果集取到上限还有剩：不能续取，只能调大行数重跑。 */
  const truncated = !!set?.hasMore;
  /** 列名 → NC 中文名。查不到（非 NC 库 / 算出来的列）时表头照旧显示类型。 */
  const zh = useColumnZh(tab.connId, entry.sql, columns);

  const subbar = sets.length > 1 ? <div className="dbx-settabs" role="tablist" aria-label="结果集">{sets.map((s,i)=><button key={i} type="button" role="tab" aria-selected={i===at} className="dbx-settab" data-on={i===at || undefined} onClick={()=>setPick(i)}>结果集 {i+1}<span className="dbx-cnt">{thousands(s.rows.length)}{s.hasMore ? "+" : ""}</span></button>)}</div> : undefined;

  return (
    <div className="dbx-rset">
      <ResultTable
        key={at}
        tabs={tabs}
        subbar={subbar}
        settings={<QuerySettings tab={tab} />}
        columns={columns}
        rows={rows}
        table={guessTable(entry.sql)}
        layoutKey={`${tab.connId}:${guessTable(entry.sql) || columns.map(c=>c.name).join("|")}`}
        snapshot={{source:dbSourceOf(connOf(tab.connId)),sql:entry.sql,at:entry.completedAt ?? Date.now(),complete:sets.length ? !truncated : !entry.hasMore,columns,rows}}
        meta={
          <>
            {sets.length > 1 && <>第 {at + 1}/{sets.length} 个结果集 · </>}
            {entry.ms} ms
            {truncated ? " · 到行数上限" : entry.hasMore && !sets.length ? " · 还有更多" : ""}
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
        onServerSort={sets.length ? undefined : (col, dir) => void reSortOnServer(tab.id, entry.sql, columns[col]?.name ?? "", dir)}
        transferSource={{connId:tab.connId,resultId:`${entry.id}:${at}`,tabId:tab.id,sql:entry.sql,source:dbSourceOf(connOf(tab.connId)),complete:sets.length ? !truncated : !entry.hasMore,canRequery:!sets.length,timeoutSec:tab.timeoutSec,table:guessTable(entry.sql),sheets:sets.length>1 ? sets.map((s,i)=>({name:`结果集 ${i+1}${s.hasMore ? "-部分" : ""}`,data:{columns:s.columns,rows:s.rows,query:entry.sql}})) : undefined}}
        zh={zh}
        foot={
          <div className="dbx-rfoot">
            <span>已取 {thousands(rows.length)} 行</span>
            {entry.moreError && <span role="status">{entry.moreError}</span>}
            {entry.hasMore && !entry.moreError && !sets.length && (
              <button
                type="button"
                className="dbx-lk"
                disabled={entry.loadingMore || !isLast || tab.running}
                title={isLast ? "" : "这条会话上后来又执行过别的语句，游标已换掉：重新执行这条再加载"}
                onClick={() => void loadMore(tab.id, entry.id)}
              >
                {entry.loadingMore ? "加载中…" : `加载下 ${tab.maxRows} 行`}
              </button>
            )}
            {truncated && (
              <span className="dbx-muted">
                结果集还有更多：把「每次取」调大后重新执行（右上齿轮；隐式结果集不能接着往下取）
              </span>
            )}
            <span className="dbx-sp" />
          </div>
        }
      />
    </div>
  );
}
