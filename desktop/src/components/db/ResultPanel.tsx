import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { DbErrorBox } from "./DbErrorBox";
import { PlanView } from "./PlanView";
import { RowsEntryView } from "./RowsEntryView";
import { thousands } from "../../lib/db";
import { statsText, statsTitle } from "../../lib/dbStats";
import { ownsCursor, patchTab, rtOf, summaryOf, type ResultEntry, type SqlTab } from "../../lib/dbStore";

/** SQL 控制台下半：每条语句一个结果标签 + 执行计划 + 输出。 */
export function ResultPanel({ tab, height, onLocate }: { tab: SqlTab; height: number; onLocate?:(line:number)=>void }) {
  const view = tab.view ?? tab.results[tab.results.length - 1]?.id ?? "output";
  const cur = tab.results.find((r) => r.id === view);
  const setView = (v: string) => patchTab<SqlTab>(tab.id, { view: v });
  const rt = rtOf(tab.connId);
  const tables = (rt.tables ?? []).map((t) => t.name);
  // 槽各自独立事务：带槽的标签把事务状态写在标签上，primary 才看连接的 `rt.tx`
  // （见 `dbStore` 的 txAction / 结果写回）。这里读错对象就会出现「上方黄条说
  // 未提交 1 条，结果页说自动提交已生效」——同屏两个相反的结论。
  // 读不到时保持 undefined：宁可说「未知」，也不要替用户断言「已生效」。
  const autoCommit = (tab.slot ? tab.tx : rt.tx)?.autoCommit ?? rt.info?.autoCommit;

  const tabs = <ResultTabs tab={tab} view={view} setView={setView} />;

  return (
    <div className="dbx-res" style={{ height }}>
      {view === "plan" && tab.plan ? (
        <>
          <ViewBar tabs={tabs} running={tab.running} />
          <PlanView plan={tab.plan} connId={tab.connId} />
        </>
      ) : view === "output" || !cur ? (
        <>
          <ViewBar tabs={tabs} running={tab.running} />
          <OutputView tab={tab} />
        </>
      ) : cur.kind === "rows" ? (
        <RowsEntryView
          key={cur.id}
          tab={tab}
          entry={cur}
          isLast={ownsCursor(tab.connId, tab.slot, cur.id)}
          tabs={tabs}
        />
      ) : (
        <>
          <ViewBar tabs={tabs} running={tab.running} />
          <EntryView tab={tab} entry={cur} tables={tables} autoCommit={autoCommit} onLocate={onLocate} />
        </>
      )}
    </div>
  );
}

/** 结果标签：多个语句各自一个，计划与输出常驻在最后。 */
function ResultTabs({ tab, view, setView }: { tab: SqlTab; view: string; setView: (v: string) => void }) {
  return (
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
    </div>
  );
}

/** 非表格视图（计划 / 输出 / 错误 / 更新）的结果条：只有标签与执行中状态。 */
function ViewBar({ tabs, running }: { tabs: ReactNode; running: boolean }) {
  return (
    <div className="dbx-rbar">
      {tabs}
      <span className="dbx-sp" />
      {running && (
        <span className="dbx-busy">
          <Icon name="spinner" size={12} />
          执行中…
        </span>
      )}
    </div>
  );
}

function EntryView({ tab, entry, tables, autoCommit, onLocate }: { tab: SqlTab; entry: ResultEntry; tables: string[]; autoCommit?: boolean; onLocate?:(line:number)=>void }) {
  if (entry.kind === "error") return <div style={{ overflow: "auto" }}><DbErrorBox error={entry.error ?? ""} sql={entry.sql} knownTables={tables} connId={tab.connId} onLocate={()=>onLocate?.(entry.startLine ?? 1)} index={tab.results.length > 1 ? entry.index : undefined} /></div>;
  if (entry.kind === "update")
    return (
      <div className="dbx-update">
        <span className="big">{entry.updateCount >= 0 ? `影响 ${thousands(entry.updateCount)} 行` : "执行完成"}</span>
        <span className="dbx-muted">
          {entry.ms} ms ·{" "}
          {autoCommit === undefined
            ? "提交状态未知：看上方有没有未提交事务黄条"
            : autoCommit
              ? "自动提交模式，已生效"
              : "手动提交模式：上方黄条里提交或回滚"}
        </span>
        <StatsLine stats={entry.stats} />
      </div>
    );
  // rows 走 `RowsEntryView`（它要把结果标签接进同一条结果条）；这里只剩非表格视图
  return null;
}

/** Autotrace 统计行（A2）。`stats` 为 null 时**整行不渲染**——读不到统计不等于 0。 */
function StatsLine({ stats }: { stats: ResultEntry["stats"] }) {
  const text = statsText(stats);
  if (!text) return null;
  return (
    <span className="dbx-stats" title={statsTitle(stats) ?? undefined}>
      <Icon name="activity" size={12} />
      {text}
    </span>
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
