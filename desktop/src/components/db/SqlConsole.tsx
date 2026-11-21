import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../ui/toast";
import { SqlToolbar } from "./SqlToolbar";
import { SqlEditor, type SqlEditorApi, type SqlExecutionScope, type SqlRunMode, type RunStmt } from "./SqlEditor";
import { ResultPanel } from "./ResultPanel";
import { HistoryDrawer } from "./HistoryDrawer";
import { SnippetDrawer } from "./SnippetDrawer";
import { SqlCompletionMemoryDrawer } from "./SqlCompletionMemoryDrawer";
import { SessionDrawer } from "./SessionDrawer";
import { InsertExportDialog } from "./InsertExportDialog";
import { ValueSearchDialog } from "./ValueSearchDialog";
import { ScriptReplayDialog } from "./ScriptReplayDialog";
import { SqlDangerDialog } from "./SqlDangerDialog";
import { SqlOutlineBar } from "./SqlOutlineBar";
import { explain, newConsole, runStatements } from "../../lib/dbActions";
import { dangerousStatements } from "../../lib/sqlDanger";
import { cancelOperation, getOperations } from "../../lib/operations";
import { dbApi, dbSourceOf } from "../../lib/dbApi";
import { connectionKey } from "../../lib/dbResultContext";
import { sqlQuickFixes } from "../../lib/sqlQuickFix";
import { bindQuery, canParameterizeQuery, queryParameters } from "../../lib/sqlQueryParameters";
import { SqlParameterDialog } from "./SqlParameterDialog";
import { friendlyDbError } from "../../lib/db";
import { guessTable } from "../../lib/resultExport";
import { changeSchema, closeSessionPanel, columnsOf, connOf, isRunning, openSessionPanel, rtOf, sqlTabOf, useDbSelector, type SqlTab } from "../../lib/dbStore";
import { repairResultContext } from "../../lib/dbQuickFixContext";
import { useSqlConsoleSplit, type SqlConsoleFocus } from "../../hooks/useSqlConsoleSplit";
import { useSqlRunConfirm } from "../../hooks/useSqlRunConfirm";
import { useViewActive } from "../../lib/viewActivity";
import { querySnippet, updateSnippet } from "../../lib/dbSnippets";
import "../../db-execution.css";
/** SQL 控制台：工具条 / 事务条 / 编辑器 / 可拖高度的结果区 / 历史与会话抽屉。 */

export function SqlConsole({ tab }: { tab: SqlTab }) {
  const active = useViewActive();
  const activeRef = useRef(active); activeRef.current = active;
  const api = useRef<SqlEditorApi | null>(null);
  const split = useSqlConsoleSplit(tab.id);
  const [scope,setScope]=useState<SqlExecutionScope | null>(null);
  const [outline, setOutline] = useState<{ tabId: string; statements: RunStmt[] } | null>(null);
  const revealOutline = useCallback((line: number) => api.current?.reveal(line), []);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const executingScopes = useRef(new Map<string, SqlExecutionScope>());
  const activeTabId = useRef(tab.id); activeTabId.current = tab.id;
  /** 右侧抽屉：历史与片段互斥（同一列位置，同时开就挤成两栏了）。 */
  const [side, setSide] = useState<"history" | "snips" | "memory" | null>(null);
  // 会话面板是页级状态（按钮在工具条、抽屉在 body 里），放 store 才不用层层回调
  const sessOpen = useDbSelector((s) => s.sessionPanel?.connId === tab.connId && tab.connId != null);
  /** 导出对话框：光标处那条语句 + 猜出来的表名。 */
  const [exp, setExp] = useState<{ sql: string; table: string } | null>(null);
  /** 全库按值反查（连接级工具，从工具条开）。 */
  const [vsOpen, setVsOpen] = useState(false);
  /** 回放 .sql 文件（按名字取文件，不进编辑器）。 */
  const [srOpen, setSrOpen] = useState(false);
  const tabId = tab.id;
  // 危险语句确认 / 参数输入两个弹框；切标签、换连接时 hook 里一起清掉。
  const { danger, askDanger, takeDanger, cancelDanger, parameters, setParameters } = useSqlRunConfirm(tabId, tab.connId);
  useEffect(()=>{const insert=(e:Event)=>{const v=(e as CustomEvent<{tabId:string;text:string}>).detail;if(v.tabId===tab.id) api.current?.insert(v.text);};window.addEventListener("ncforge-db-insert-name",insert);return()=>window.removeEventListener("ncforge-db-insert-name",insert);},[tab.id]);

  const execute = useCallback(
    async (mode: SqlRunMode, stmts: RunStmt[], collectStats: boolean, bound?: { bindings?: ReturnType<typeof bindQuery>[]; targetCurrent?: () => boolean; dangerConfirmed?: boolean }) => {
      const executionScope = { tabId, selected: mode === "auto" && scopeRef.current?.tabId === tabId && scopeRef.current.selected, statements: stmts };
      api.current?.markRun?.(stmts);
      executingScopes.current.set(tabId, executionScope);
      try {
        const outcome = await runStatements(tabId, stmts, { collectStats, ...bound });
        if (outcome.failLine && activeRef.current && activeTabId.current === tabId && api.current?.canRevealExecutionError?.(stmts[0])) {
          if (outcome.failColumn !== undefined) api.current.reveal(outcome.failLine, outcome.failColumn);
          else api.current.reveal(outcome.failLine);
        }
      } finally {
        if (executingScopes.current.get(tabId) === executionScope) executingScopes.current.delete(tabId);
      }
    },
    [tabId],
  );

  /**
   * 执行入口。危险语句在这里先拦一次：没有 WHERE 的 UPDATE / DELETE 弹框确认，
   * DROP / TRUNCATE 只给一条 warning——删表的人通常是有意的，每次都拦会变成点确认训练。
   */
  const run = useCallback(
    async (mode: SqlRunMode, collectStats = false) => {
      const stmts = api.current?.target(mode) ?? [];
      if (stmts.length === 0) {
        toast(mode === "current" ? "光标处没有语句" : "执行范围内没有可执行的语句", "info");
        return;
      }
      const names = [...new Set(stmts.flatMap(s => {
        const names = queryParameters(s.text);
        return names.length && canParameterizeQuery(s.text) ? names : [];
      }))];
      if (tab.connId && names.length) {
        if (stmts.length !== 1) return toast("请单独执行带参数的查询。", "info");
        const connId = tab.connId;
        const conn = connOf(connId), identity = connectionKey(conn);
        const currentSchema = () => rtOf(connId).currentSchema ?? rtOf(connId).info?.schema;
        const schema = currentSchema();
        const targetCurrent = () => activeRef.current && activeTabId.current === tabId &&
          sqlTabOf(tabId)?.connId === connId && connectionKey(connOf(connId)) === identity &&
          (schema === undefined || currentSchema() === schema);
        setParameters({
          names, target: [dbSourceOf(conn), schema ?? conn?.user].filter(Boolean).join(" · "),
          snippet: querySnippet(connId, schema, stmts[0].text),
          submit: values => {
            setParameters(null);
            if (!targetCurrent()) return toast("执行目标已变化，请重新发起查询。", "warning");
            void execute(mode, stmts, false, { bindings: [bindQuery(stmts[0].text, values)], targetCurrent });
          },
        });
        return;
      }
      const found = dangerousStatements(stmts.map((s) => s.text));
      for (const item of found) if (item.finding.advisory) toast(`这条语句不可撤销：${item.finding.verb} ${item.finding.table}`, "warning");
      const blocked = found.filter((item) => !item.finding.advisory);
      if (blocked.length > 0 && tab.connId) {
        // 语句在这一刻已经取出来了：等用户在框里按「仍要执行」时编辑器可能已经改过，
        // 那就不是他确认过的那一条了。
        askDanger({ tabId, mode, stmts, collectStats }, blocked, stmts.length);
        return;
      }
      // `dangerConfirmed`：危险语句已经在这里问过（advisory 也 toast 过），
      // 不再让 `runStatements` 里的闸门问第二遍。
      await execute(mode, stmts, collectStats, { dangerConfirmed: true });
    },
    [execute, tab.connId, tabId, askDanger, setParameters],
  );

  const confirmDanger = () => {
    const p = takeDanger();
    // 双保险：切标签的 effect 已经清过，这里再核一次标签身份
    if (p && p.tabId !== tabId) { toast("标签已切换，这次执行已取消", "info"); return; }
    if (p) void execute(p.mode, p.stmts, p.collectStats, { dangerConfirmed: true });
  };

  const onExplain = () => {
    const s = api.current?.target("current")[0];
    if (s) void explain(tabId, s.text);
  };

  /** 导出用的是「光标处这条语句」，不是编辑区全部——和「执行」的取值口径保持一致。 */
  const onExport = () => {
    const s = api.current?.target("current")[0];
    if (!s) return toast("光标处没有语句", "info");
    setExp({ sql: s.text, table: guessTable(s.text) });
  };

  /**
   * 停止：只发取消，不改 running——被取消的语句会带着 ORA-01013 从原来那个请求返回，
   * 由 runStatements 正常收尾把 running 置回 false。这里抢先置 false 会让结果区
   * 在真正的响应到达前先闪一下「没有错误」。
   *
   * 必须带上标签的会话槽（A0）：不带就取消了 primary，而真正在跑的是槽里那条。
   */
  const onStop = useCallback(() => {
    if (!tab.connId) return;
    // 执行计划也是一个可取消任务，且现在跑在标签自己的会话上；先找任务，
    // 再退回到直接取消槽，避免「停止」把另一条空闲能会话取消掉。
    const task=getOperations().find(o=>(o.key===`db.sql:${tab.id}` || o.key===`db.explain:${tab.id}`) && o.endedAt===undefined);
    if(task) void cancelOperation(task.id);
    else void dbApi.cancel(tab.connId, tab.slot).catch((e) => toast(`取消失败：${friendlyDbError(e)}`, "error"));
  }, [tab.id,tab.connId, tab.slot]);

  const focus = (mode: SqlConsoleFocus) => {
    split.setFocus(mode);
    requestAnimationFrame(() => {
      if (!activeRef.current || activeTabId.current !== tab.id) return;
      if (mode === "results") split.bodyRef.current?.querySelector<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true });
      else api.current?.focus();
    });
  };
  return (
    <div className="dbx-console">
      <SqlToolbar
        tab={tab}
        scope={isRunning(tab) ? executingScopes.current.get(tab.id) ?? null : scope}
        scriptCount={outline?.tabId === tab.id ? outline.statements.length : undefined}
        focusMode={split.focus}
        onFocusChange={focus}
        onRun={(m, collectStats) => void run(m, collectStats)}
        onStop={onStop}
        onExplain={onExplain}
        onFormat={(scope) => api.current?.format(scope)}
        onExport={onExport}
        onValueSearch={() => setVsOpen(true)}
        onScriptReplay={() => setSrOpen(true)}
        historyOpen={side === "history"}
        onHistory={() => setSide(side === "history" ? null : "history")}
        snipsOpen={side === "snips"}
        onSnips={() => setSide(side === "snips" ? null : "snips")}
        memoryOpen={side === "memory"}
        onMemory={() => setSide(side === "memory" ? null : "memory")}
        sessionsOpen={sessOpen}
        onSessions={() => (sessOpen ? closeSessionPanel() : openSessionPanel(tab.connId))}
      />
      {/* 多语句脚本的导航：点了跳到该语句首行。条数少时组件自己返回 null。 */}
      {outline?.tabId === tab.id && <SqlOutlineBar statements={outline.statements} onPick={revealOutline} />}
      {danger && tab.connId && (
        <SqlDangerDialog items={danger.items} total={danger.total} connId={tab.connId} slot={tab.slot ?? null} onCancel={cancelDanger} onConfirm={confirmDanger} />
      )}
      {parameters && <SqlParameterDialog names={parameters.names} target={parameters.target} onClose={() => setParameters(null)} onRun={parameters.submit}
        initialTypes={parameters.snippet?.parameterTypes} onSaveTypes={parameters.snippet ? parameterTypes => updateSnippet(parameters.snippet!.id, { parameterTypes }) : undefined} />}
      {exp && tab.connId && (
        <InsertExportDialog tabId={tab.id}
          connId={tab.connId}
          table={exp.table}
          sql={exp.sql}
          onClose={() => setExp(null)}
        />
      )}
      {vsOpen && tab.connId && (
        <ValueSearchDialog tabId={tab.id} connId={tab.connId} onClose={() => setVsOpen(false)} />
      )}
      {srOpen && tab.connId && (
        <ScriptReplayDialog tab={tab} onClose={() => setSrOpen(false)} />
      )}
      <div className="dbx-console-body">
        <div ref={split.bodyRef} className="dbx-console-main" data-focus={split.focus}>
          {/* 空页才出现的一行提示：新标签打开后最常问的三件事。不挡输入（pointer-events:none）。 */}
          {tab.sql.trim() === "" && tab.results.length === 0 && split.focus !== "results" && (
            <div className="dbx-sql-empty-hint" aria-hidden>
              写 SQL 后 Ctrl+Enter 执行 · 直接打表名就有提示 · 按 <kbd>?</kbd> 看全部快捷键
            </div>
          )}
          <SqlEditor tabId={tab.id} initial={tab.sql} onRun={(m) => void run(m)} apiRef={api} onScope={setScope} onOutline={setOutline} visible={active && split.focus !== "results"} />
          <div
            className="dbx-splitbar"
            hidden={split.focus !== "split"}
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整结果区高度"
            title="上下拖动调整结果区高度"
            data-dragging={split.dragging || undefined}
            tabIndex={0}
            aria-valuemin={split.min}
            aria-valuemax={split.max}
            aria-valuenow={split.height}
            onKeyDown={split.onKeyDown}
            onPointerDown={e => {
              if (!e.isPrimary || e.button !== 0) return;
              e.preventDefault();
              try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* Window listeners cover environments without capture. */ }
              split.startDrag(e.clientY, e.pointerId);
            }}
          />
          <ResultPanel tab={tab} height={split.resultHeight} onReviewOriginal={sql => void newConsole(tab.connId, sql)} fixes={{
            find: async entry => {
              const current = repairResultContext(entry, tabId);
              return current ? sqlQuickFixes(entry.error ?? "", entry.sql, current.tables,
                async table => (await columnsOf(current.connId, table)).map(column => column.name),
                async name => dbApi.locate(current.connId, name)) : [];
            },
            apply: (entry, fix) => {
              const current = repairResultContext(entry, tabId);
              const stale = () => toast("SQL 或连接已变化，请重新执行后再修复。", "warning");
              if (!current) { stale(); return; }
              if (fix.schema !== undefined) {
                void changeSchema(current.connId, fix.schema).then(s => toast(`默认 schema 已切到 ${s || "登录账号"} · 请重新执行`, "success"), e => toast(friendlyDbError(e), "error"));
                return;
              }
              if (split.focus === "results") split.setFocus("split");
              if (!api.current?.fix?.({ editorSql: current.editorSql, start: current.offset + fix.start, end: current.offset + fix.end, text: fix.text })) stale();
            },
          }} onLocate={line => {
            if (split.focus === "results") split.setFocus("split");
            api.current?.reveal(line);
          }} onFillSql={sql => {
            // 「带出子表明细」：联查 SQL 填入编辑器，执不执行由用户定（与历史/片段抽屉同一口径）。
            if (split.focus === "results") split.setFocus("split");
            api.current?.setText(sql);
            toast("联查 SQL 已填入编辑器 · 确认后执行", "success");
          }} />
        </div>
        {side === "history" && tab.connId && (
          <HistoryDrawer
            connId={tab.connId}
            onClose={() => setSide(null)}
            onPick={(sql, runNow) => {
              api.current?.setText(sql);
              // 显式选择「填入并执行」后整段执行（可能是脚本）
              if (runNow && sqlTabOf(tabId)) void run("script");
            }}
          />
        )}
        {side === "snips" && tab.connId && (
          <SnippetDrawer
            connId={tab.connId}
            // 与执行当前语句、导出 INSERT 一样，优先使用选区或光标处的语句。
            getSql={() => (api.current?.target("current") ?? []).map((s) => s.text).join("\n\n")}
            onClose={() => setSide(null)}
            onPick={(sql) => api.current?.setText(sql)}
          />
        )}
        {side === "memory" && tab.connId && <SqlCompletionMemoryDrawer connId={tab.connId} onClose={() => setSide(null)} />}
        {sessOpen && tab.connId && <SessionDrawer connId={tab.connId} visible={active} onClose={closeSessionPanel} />}
      </div>
    </div>
  );
}
