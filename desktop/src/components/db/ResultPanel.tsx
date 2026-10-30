import { useEffect, useRef } from "react";
import { Icon } from "../ui/icon";
import { ResultTable } from "./ResultTable";
import { DbErrorBox } from "./DbErrorBox";
import { PlanView } from "./PlanView";
import { thousands } from "../../lib/db";
import { guessTable } from "../../lib/resultExport";
import { loadMore, ownsCursor, patchTab, rtOf, summaryOf, type ResultEntry, type SqlTab } from "../../lib/dbStore";

/** SQL 控制台下半：每条语句一个结果标签 + 执行计划 + 输出。 */
export function ResultPanel({ tab, height }: { tab: SqlTab; height: number }) {
  const view = tab.view ?? tab.results[tab.results.length - 1]?.id ?? "output";
  const cur = tab.results.find((r) => r.id === view);
  const setView = (v: string) => patchTab<SqlTab>(tab.id, { view: v });
  const tables = (rtOf(tab.connId).tables ?? []).map((t) => t.name);
  const autoCommit = rtOf(tab.connId).tx?.autoCommit ?? true;

  return (
    <div className="dbx-res" style={{ height }}>
      <div className="dbx-rtabs" role="tablist">
        {tab.results.map((r) => (
          <button key={r.id} type="button" role="tab" className="dbx-rtab" data-on={view === r.id || undefined} title={r.sql} onClick={() => setView(r.id)}>
            {r.kind === "error" ? <Icon name="alert" size={12} /> : <Icon name={r.kind === "rows" ? "database" : "check"} size={12} />}
            {tab.results.length > 1 ? `${r.index}·` : "结果"}
            <span className={r.kind === "error" ? "bad" : undefined}>{summaryOf(r)}</span>
          </button>
        ))}
        {tab.plan && (
          <button type="button" role="tab" className="dbx-rtab" data-on={view === "plan" || undefined} onClick={() => setView("plan")}>
            <Icon name="activity" size={12} />
            执行计划
          </button>
        )}
        <button type="button" role="tab" className="dbx-rtab" data-on={view === "output" || undefined} onClick={() => setView("output")}>
          <Icon name="terminal" size={12} />
          输出
          {tab.output.length > 0 && <span className="dbx-cnt">{tab.output.length}</span>}
        </button>
        <span className="dbx-sp" />
        {tab.running && (
          <span className="dbx-muted" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <Icon name="spinner" size={12} />
            执行中…
          </span>
        )}
      </div>
      {view === "plan" && tab.plan ? (
        <PlanView plan={tab.plan} />
      ) : view === "output" || !cur ? (
        <OutputView tab={tab} />
      ) : (
        <EntryView key={cur.id} tab={tab} entry={cur} tables={tables} autoCommit={autoCommit} />
      )}
    </div>
  );
}

function EntryView({ tab, entry, tables, autoCommit }: { tab: SqlTab; entry: ResultEntry; tables: string[]; autoCommit: boolean }) {
  if (entry.kind === "error") return <div style={{ overflow: "auto" }}><DbErrorBox error={entry.error ?? ""} sql={entry.sql} knownTables={tables} index={tab.results.length > 1 ? entry.index : undefined} /></div>;
  if (entry.kind === "update")
    return (
      <div className="dbx-update">
        <span className="big">{entry.updateCount >= 0 ? `影响 ${thousands(entry.updateCount)} 行` : "执行完成"}</span>
        <span className="dbx-muted">
          {entry.ms} ms · {autoCommit ? "自动提交模式，已生效" : "手动提交模式：上方黄条里提交或回滚"}
        </span>
      </div>
    );
  const isLast = ownsCursor(tab.connId, entry.id);
  return (
    <ResultTable
      columns={entry.columns}
      rows={entry.rows}
      table={guessTable(entry.sql)}
      meta={
        <>
          <b>{thousands(entry.rows.length)}</b> 行{entry.hasMore ? "（还有更多）" : ""} · {entry.ms} ms
        </>
      }
      foot={
        <div className="dbx-rfoot">
          <span>已取 {thousands(entry.rows.length)} 行</span>
          {entry.hasMore && (
            <button
              type="button"
              className="dbx-lk"
              disabled={entry.loadingMore || !isLast || tab.running}
              title={isLast ? "" : "这个连接上后来又执行过别的语句，游标已换掉：重新执行这条再加载"}
              onClick={() => void loadMore(tab.id, entry.id)}
            >
              {entry.loadingMore ? "加载中…" : `加载下 ${tab.maxRows} 行`}
            </button>
          )}
          <span className="dbx-sp" />
          <label>
            每次取{" "}
            <input type="number" min={1} max={10000} value={tab.maxRows} onChange={(e) => patchTab<SqlTab>(tab.id, { maxRows: Math.max(1, Math.min(10000, Number(e.target.value) || 500)) })} />{" "}
            行
          </label>
          <label>
            超时{" "}
            <input type="number" min={1} max={3600} value={tab.timeoutSec} onChange={(e) => patchTab<SqlTab>(tab.id, { timeoutSec: Math.max(1, Math.min(3600, Number(e.target.value) || 30)) })} />{" "}
            秒
          </label>
        </div>
      }
    />
  );
}

function OutputView({ tab }: { tab: SqlTab }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [tab.output.length]);
  return (
    <div ref={ref} className="dbx-output">
      {tab.output.length === 0 && <span className="info">这里显示每条语句的执行情况与 DBMS_OUTPUT。</span>}
      {tab.output.map((l, i) => (
        <div key={i} className={l.tone}>
          {l.text}
        </div>
      ))}
    </div>
  );
}
