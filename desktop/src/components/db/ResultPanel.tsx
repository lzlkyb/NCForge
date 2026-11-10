import { QueryField } from "./QueryField";
import { useOperationById } from "../../lib/operations";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { SqlExecutionFeedback } from "./SqlExecutionFeedback";
import { DbErrorBox } from "./DbErrorBox";
import { PlanView } from "./PlanView";
import { RowsEntryView } from "./RowsEntryView";
import { ResultTabList, resultTabId } from "./ResultTabList";
import { ResultBaselineSummary } from "./ResultCompare";
import { thousands } from "../../lib/db";
import { statsText, statsTitle } from "../../lib/dbStats";
import { ownsCursor, patchTab, rtOf, summaryOf, type ResultEntry, type SqlTab } from "../../lib/dbStore";
import { ask } from "../../lib/dbConfirm";
import { clearEditsForTab, pendingEdits, pendingForTab, resultEditKey, useEditRevision } from "../../lib/dbDirtyEdits";

/** SQL 控制台下半：每条语句一个结果标签 + 执行计划 + 输出。 */
export function ResultPanel({ tab, height, onLocate }: { tab: SqlTab; height: number; onLocate?:(line:number)=>void }) {
  const [motionHost, setMotionHost] = useState<HTMLDivElement | null>(null);
  /** 看过的结果视图保活：切标签回来时本地筛选、排序、滚动与单元格选择都还在。 */
  const [kept, setKept] = useState<string[]>([]);
  const operation = useOperationById(tab.executionId);
  const active = !!operation && operation.endedAt === undefined;
  const valid = tab.view === "output" || tab.view === "plan" && tab.plan || tab.results.some(r => r.id === tab.view);
  const view = valid ? tab.view! : tab.results[tab.results.length - 1]?.id ?? "output";
  const cur = tab.results.find((r) => r.id === view);
  const previous = !!cur && active && (!cur.completedAt || cur.completedAt < operation.startedAt);
  const motionState = active ? operation.state : operation?.state ?? "idle";
  useEditRevision();
  useEffect(() => {
    if (cur?.kind !== "rows" || kept.includes(cur.id)) return;
    setKept(k => [...k, cur.id]);
  }, [cur, kept]);
  const rowViews = tab.results.filter(r => r.kind === "rows" && (r.id === view || kept.includes(r.id)));
  /** 切结果标签不再卸载行视图，本地改动不会丢，所以这里不用再问。 */
  const setView = (v: string) => { if (v !== view) patchTab<SqlTab>(tab.id, { view: v }); };
  const rt = rtOf(tab.connId);
  const tables = (rt.tables ?? []).map((t) => t.name);
  const prefix = `dbx-results-${tab.id}`;
  const items = [
    ...tab.results.map(r => {
      const dirty = r.kind === "rows" ? pendingEdits(resultEditKey(tab.id, r.id)) : 0;
      return { id: r.id, title: r.sql, label: <>
        {dirty > 0 && <span className="dbx-dirty-dot" role="img" aria-label={`有 ${dirty} 处未写回的改动`} title={`有 ${dirty} 处未写回的改动`} />}
        <Icon name={r.cancelled ? "stop" : r.kind === "error" ? "alert" : r.kind === "rows" ? "database" : "check"} size={13} />
        {r.kind === "rows" ? `数据 ${r.index}` : `语句 ${r.index}`}
        {r.kind === "rows" && (r.sets?.length ?? 0) > 1 && <span className="dbx-cnt">{r.sets!.length} 个结果集</span>}
        {r.kind !== "rows" && <span className={r.kind === "error" && !r.cancelled ? "bad" : undefined}>{summaryOf(r)}</span>}
      </> };
    }),
    ...(tab.plan ? [{ id: "plan", label: <><Icon name="activity" size={13} />执行计划</> }] : []),
    { id: "output", label: <><Icon name="terminal" size={13} />输出{tab.output.length > 0 && <span className="dbx-cnt">{tab.output.length}</span>}</> },
  ];
  const release = async () => {
    const count = pendingForTab(tab.id);
    if (count > 0) {
      const ok = await ask(
        "有未写回的改动",
        `还有 ${count} 处改动没有写回数据库。释放结果会把这些改动一起丢掉，确定吗？`,
        "丢弃并释放",
        true,
      );
      if (!ok) return;
    }
    clearEditsForTab(tab.id);
    patchTab<SqlTab>(tab.id, { results: [], plan: null, view: "output" });
  };
  const tabs = <><ResultTabList prefix={prefix} label="查询结果" items={items} value={view} onSelect={(id) => void setView(id)} />
    <ResultBaselineSummary />
    <SqlExecutionFeedback executionId={tab.executionId} previousAt={cur ? cur.completedAt ?? 0 : undefined} />
    {cur && !active && <span className="dbx-result-runmeta" title={cur.completedAt ? `执行完成于 ${new Date(cur.completedAt).toLocaleTimeString()}` : undefined}><span>{cur.kind === "rows" ? `${thousands(cur.rows.length)} 行 · ` : ""}{cur.ms} ms</span></span>}
    {tab.results.length > 0 && <button type="button" className="dbx-ibtn" disabled={tab.running} aria-label="释放查询结果" title="释放已读取结果，保留 SQL 和事务" onClick={() => void release()}><Icon name="close" size={14}/></button>}
  </>;

  return (
    <div className="dbx-res" style={{ height }}>
      <div className="dbx-result-head">{tabs}</div>
      <div className="dbx-result-view dbx-query-surface" ref={setMotionHost} id={`${prefix}-panel`} role="tabpanel" tabIndex={0} aria-labelledby={resultTabId(prefix, view)}>
      {motionHost && <QueryField key={tab.executionId ?? "idle"} host={motionHost} state={motionState} previous={previous} />}
      {view === "plan" && tab.plan ? (
        <PlanView plan={tab.plan} connId={tab.connId} />
      ) : view === "output" || !cur ? (
        <OutputView tab={tab} />
      ) : cur.kind === "rows" ? (
        // 保活所有看过的结果视图，只把非当前项隐藏：切标签不丢筛选 / 排序 / 滚动 / 选择。
        rowViews.map(r => (
          <div key={r.id} style={{ display: r.id === cur.id ? undefined : "none", height: "100%" }}>
            <RowsEntryView tab={tab} entry={r} isLast={ownsCursor(tab.connId, tab.slot, r.id)} onLocate={onLocate} />
          </div>
        ))
      ) : (
        <EntryView tab={tab} entry={cur} tables={tables} autoCommit={cur.autoCommit} onLocate={onLocate} />
      )}
      </div>
    </div>
  );
}

function EntryView({ tab, entry, tables, autoCommit, onLocate }: { tab: SqlTab; entry: ResultEntry; tables: string[]; autoCommit?: boolean; onLocate?:(line:number)=>void }) {
  // 取消执行也要把错误码、相似表建议和「重新连接」入口留在页面上；
  // 只在摘要上标注「已停止」，不能整个吞掉 DbErrorBox（P1-3）。
  if (entry.kind === "error") return <div style={{ overflow: "auto" }}><DbErrorBox error={entry.error ?? ""} errorCode={entry.errorCode} sql={entry.sql} knownTables={tables} connId={tab.connId} tabId={tab.id} slot={tab.slot} cancelled={entry.cancelled} onLocate={()=>onLocate?.(entry.startLine ?? 1)} index={tab.results.length > 1 ? entry.index : undefined} /></div>;
  if (entry.kind === "update")
    return (
      <div className="dbx-update">
        <span className="big">{entry.updateCount >= 0 ? `影响 ${thousands(entry.updateCount)} 行` : "执行完成"}</span>
        <span className="dbx-muted">
          {entry.ms} ms ·{" "}
          {autoCommit === undefined
            ? "提交状态待核对"
            : autoCommit
              ? "已自动提交"
              : "执行时为手动提交 · 当前状态以连接详情与提交/回滚按钮为准"}
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
