import { QueryField } from "./QueryField";
import { useOperationById } from "../../lib/operations";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { SqlExecutionFeedback } from "./SqlExecutionFeedback";
import { DbErrorBox } from "./DbErrorBox";
import { PlanView } from "./PlanView";
import { RowsEntryView } from "./RowsEntryView";
import { ResultTabList, resultTabId } from "./ResultTabList";
import { ResultPaneHeading } from "./ResultPaneHeading";
import { ResultBaselineSummary } from "./ResultCompare";
import { thousands } from "../../lib/db";
import { statsText, statsTitle } from "../../lib/dbStats";
import { isRunning, ownsCursor, patchTab, rtOf, summaryOf, type ResultEntry, type SqlTab } from "../../lib/dbStore";
import { ask } from "../../lib/dbConfirm";
import { useTxEpoch } from "../../lib/dbTxEpoch";
import { txStateText } from "../../lib/txResultState";
import { clearEditsForTab, pendingEdits, pendingForTab, resultEditKey, useEditRevision } from "../../lib/dbDirtyEdits";
import { pendingResults, resultPairOf } from "../../lib/dbResultLayout";
import { guessTable } from "../../lib/resultExport";
import { statementTitle } from "../../lib/sqlStatementTitle";

/** SQL 控制台下半：每条语句一个结果标签 + 执行计划 + 输出。 */
export function ResultPanel({ tab, height, onLocate }: { tab: SqlTab; height: number; onLocate?:(line:number)=>void }) {
  const [motionHost, setMotionHost] = useState<HTMLDivElement | null>(null);
  /** 看过的结果视图保活：切标签回来时本地筛选、排序、滚动与单元格选择都还在。 */
  const [kept, setKept] = useState<string[]>([]);
  const operation = useOperationById(tab.run?.id);
  const active = !!operation && operation.endedAt === undefined;
  const pending = useMemo(() => pendingResults({ batch: tab.batch }), [tab.batch]);
  const options = useMemo(() => [...tab.results, ...pending], [tab.results, pending]);
  const valid = tab.view === "output" || tab.view === "plan" && tab.plan || options.some(r => r.id === tab.view);
  const view = valid ? tab.view! : tab.results[0]?.id ?? pending[0]?.id ?? "output";
  const layout = options.length > 1 ? tab.resultLayout ?? "tabs" : "tabs";
  const pair = useMemo(() => resultPairOf(options.map(r => r.id), tab.resultPair, view), [options, tab.resultPair, view]);
  const visible = useMemo(() => options.some(r => r.id === view) ? layout === "dual" ? pair : [view] : [], [options, view, layout, pair]);
  const cur = tab.results.find((r) => r.id === view);
  const selectedResult = options.find(r => r.id === view);
  const previous = !!cur && active && (!cur.completedAt || cur.completedAt < operation.startedAt);
  const motionState = active ? operation.state : operation?.state ?? "idle";
  useEditRevision();
  useEffect(() => {
    const next = tab.results.filter(r => r.kind === "rows" && (visible.includes(r.id) || kept.includes(r.id))).map(r => r.id);
    if (next.length !== kept.length || next.some((id, i) => id !== kept[i])) setKept(next);
  }, [tab.results, visible, kept]);
  const rowViews = tab.results.filter(r => r.kind === "rows" && (visible.includes(r.id) || kept.includes(r.id)));
  /** 切结果标签不再卸载行视图，本地改动不会丢，所以这里不用再问。 */
  const setView = (v: string) => {
    if (v !== view) patchTab<SqlTab>(tab.id, { view: v, ...(layout === "dual" && options.some(r => r.id === v) && !pair.includes(v) ? { resultPair: resultPairOf(options.map(r => r.id), [v, pair[1]], v) as [string, string] } : {}) });
  };
  const pickPane = (position: number, id: string) => {
    const next = [...pair] as [string, string]; next[position] = id;
    patchTab<SqlTab>(tab.id, { resultPair: next, view: id });
  };
  const rt = rtOf(tab.connId);
  const tables = (rt.tables ?? []).map((t) => t.name);
  const prefix = `dbx-results-${tab.id}`;
  const items = [
    ...tab.results.map(r => {
      const dirty = r.kind === "rows" ? pendingEdits(resultEditKey(tab.id, r.id)) : 0;
      const table = r.kind === "rows" ? guessTable(r.sql) : null;
      // 紧贴语句的那行注释就是它的名字（`-- 物料主档`）；没有注释才退回序号。
      const name = statementTitle(r.sql);
      const kindLabel = r.kind === "rows" ? `查询 ${r.index}` : `语句 ${r.index}`;
      return { id: r.id, title: r.sql, label: <>
        {dirty > 0 && <span className="dbx-dirty-dot" role="img" aria-label={`有 ${dirty} 处未写回的改动`} title={`有 ${dirty} 处未写回的改动`} />}
        <Icon name={r.cancelled ? "stop" : r.kind === "error" ? "alert" : r.kind === "rows" ? "database" : "check"} size={13} />
        {name ? <><span className="dbx-result-tab-name">{name}</span><span className="dbx-cnt">{kindLabel}</span></> : kindLabel}
        {table && <span className="dbx-result-tab-table">{table}</span>}
        {r.kind === "rows" && (r.sets?.length ?? 0) > 1 && <span className="dbx-cnt">{r.sets!.length} 个结果集</span>}
        {r.kind !== "rows" && <span className={r.kind === "error" && !r.cancelled ? "bad" : undefined}>{summaryOf(r)}</span>}
      </> };
    }),
    ...pending.map(r => {
      const name = statementTitle(r.sql);
      return { id: r.id, title: r.sql, label: <><Icon name={r.state === "running" ? "spinner" : r.state === "skipped" ? "stop" : "clock"} size={13} />{name ? <><span className="dbx-result-tab-name">{name}</span><span className="dbx-cnt">{`查询 ${r.index}`}</span></> : `查询 ${r.index}`}<span className="dbx-cnt">{r.state === "running" ? "执行中" : r.state === "skipped" ? "未执行" : "等待"}</span></> };
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
    patchTab<SqlTab>(tab.id, { results: [], plan: null, view: "output", batch: undefined, resultPair: undefined });
  };
  const paneHeading = (result: typeof options[number]) => layout === "dual" &&
    <ResultPaneHeading result={result} options={options.filter(o => o.id === result.id || !pair.includes(o.id))} onPick={id => pickPane(pair.indexOf(result.id), id)} onLocate={onLocate} />;

  return (
    <div className="dbx-res" style={{ height }}>
      <div className="dbx-result-head">
        <ResultTabList prefix={prefix} label="查询结果" items={items} value={view} onSelect={setView} />
        <ResultBaselineSummary /><SqlExecutionFeedback executionId={tab.run?.id} previousAt={cur ? cur.completedAt ?? 0 : undefined} />
        {layout === "tabs" && selectedResult && onLocate && <button type="button" className="dbx-ibtn"
          aria-label={`定位 SQL 第 ${selectedResult.startLine ?? 1} 行`} title={`定位 SQL 第 ${selectedResult.startLine ?? 1} 行`}
          onClick={() => onLocate(selectedResult.startLine ?? 1)}><Icon name="locateSql" size={14} /></button>}
        {options.length > 1 && <div className="dbx-result-layout" role="group" aria-label="结果布局">{(["tabs", "dual"] as const).map(mode => {
          const label = mode === "tabs" ? "标签" : "双栏";
          return <button key={mode} type="button" aria-label={label} title={label} aria-pressed={layout === mode} onClick={() => patchTab<SqlTab>(tab.id, { resultLayout: mode, resultPair: pair as [string, string] })}><Icon name={mode === "tabs" ? "panel" : "columns"} size={13} /></button>;
        })}</div>}
        {tab.results.length > 0 && <button type="button" className="dbx-ibtn" disabled={isRunning(tab)} aria-label="释放查询结果" title="释放已读取结果，保留 SQL 和事务" onClick={() => void release()}><Icon name="close" size={14}/></button>}
      </div>
      <div className="dbx-result-view dbx-query-surface" ref={setMotionHost} id={`${prefix}-panel`} role="tabpanel" tabIndex={0} aria-labelledby={resultTabId(prefix, view)}>
      {motionHost && <QueryField key={tab.run?.id ?? "idle"} host={motionHost} state={motionState} previous={previous} />}
      <div className="dbx-result-panes" data-layout={layout}>
      {rowViews.map(r => <section key={r.id} className="dbx-result-keep" hidden={!visible.includes(r.id)} style={{ order: visible.indexOf(r.id) }} aria-label={`查询 ${r.index} 结果`}>
        {paneHeading(r)}
        <RowsEntryView tab={tab} entry={r} isLast={ownsCursor(tab.connId, tab.slot, r.id)} onLocate={onLocate} />
      </section>)}
      {pending.filter(r => visible.includes(r.id)).map(r => <section key={r.id} className="dbx-result-keep" style={{ order: visible.indexOf(r.id) }} aria-label={`查询 ${r.index} 结果`}>
        {paneHeading(r)}
        <div className="dbx-result-pending" role="status"><Icon name={r.state === "running" ? "spinner" : r.state === "skipped" ? "stop" : "clock"} size={24} /><strong>{r.state === "running" ? "正在执行查询" : r.state === "skipped" ? "未执行" : "等待执行"} {r.index}</strong><span>{r.state === "skipped" ? "本次执行已结束，完成的结果仍可查看" : "前一条完成后继续执行，返回结果不会切走其他结果"}</span></div>
      </section>)}
      {tab.results.filter(r => r.kind !== "rows" && visible.includes(r.id)).map(r => <section key={r.id} className="dbx-result-keep" style={{ order: visible.indexOf(r.id) }} aria-label={`语句 ${r.index} 结果`}>
        {paneHeading(r)}
        <EntryView tab={tab} entry={r} tables={tables} onLocate={onLocate} />
      </section>)}
      {view === "plan" && tab.plan ? (
        <PlanView plan={tab.plan} connId={tab.connId} />
      ) : view === "output" || !options.some(r => r.id === view) ? (
        <OutputView tab={tab} />
      ) : null}
      </div>
      </div>
    </div>
  );
}

/**
 * 非表格结果（写语句 / 空结果）。提交状态交给 `txStateText`：按会话的提交纪元说
 * 「这条语句现在到底提交了没有」，提交之后不再继续挂着「尚未提交」。
 */
function EntryView({ tab, entry, tables, onLocate }: { tab: SqlTab; entry: ResultEntry; tables: string[]; onLocate?:(line:number)=>void }) {
  const epoch = useTxEpoch(tab.connId, tab.slot);
  // 取消执行也要把错误码、相似表建议和「重新连接」入口留在页面上；
  // 只在摘要上标注「已停止」，不能整个吞掉 DbErrorBox（P1-3）。
  if (entry.kind === "error") return <div style={{ overflow: "auto" }}><DbErrorBox error={entry.error ?? ""} errorCode={entry.errorCode} sql={entry.sql} knownTables={tables} connId={tab.connId} tabId={tab.id} slot={tab.slot} cancelled={entry.cancelled}
    // 传进来的是**语句内**行号；编辑器要的是整个脚本的行号，按语句首行换算。
    onLocate={(line) => { const base = entry.startLine ?? 1; onLocate?.(line == null ? base : base - 1 + line); }}
    index={tab.results.length > 1 ? entry.index : undefined} /></div>;
  if (entry.kind === "update")
    return (
      <div className="dbx-update">
        <span className="big">{entry.updateCount >= 0 ? `影响 ${thousands(entry.updateCount)} 行` : "执行完成"}</span>
        <span className="dbx-muted">
          {entry.ms} ms ·{" "}
          {txStateText(entry, epoch)}
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
      实际执行统计 · {text}
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
