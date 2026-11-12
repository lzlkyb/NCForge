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
import { SqlDangerDialog, type DangerItem } from "./SqlDangerDialog";
import { SqlOutlineBar } from "./SqlOutlineBar";
import { explain, runStatements } from "../../lib/dbActions";
import { dangerousStatements } from "../../lib/sqlDanger";
import { cancelOperation, getOperations } from "../../lib/operations";
import { dbApi } from "../../lib/dbApi";
import { friendlyDbError } from "../../lib/db";
import { guessTable } from "../../lib/resultExport";
import { closeSessionPanel, isRunning, openSessionPanel, sqlTabOf, useDbSelector, type SqlTab } from "../../lib/dbStore";
import { useSqlConsoleSplit, type SqlConsoleFocus } from "../../hooks/useSqlConsoleSplit";
import { useViewActive } from "../../lib/viewActivity";
import "../../db-execution.css";

/** SQL 控制台：工具条 / 事务条 / 编辑器 / 可拖高度的结果区 / 历史与会话抽屉。 */

export function SqlConsole({ tab }: { tab: SqlTab }) {
  const active = useViewActive();
  const activeRef = useRef(active); activeRef.current = active;
  const api = useRef<SqlEditorApi | null>(null);
  const split = useSqlConsoleSplit(tab.id);
  const [scope,setScope]=useState<SqlExecutionScope | null>(null);
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
  /** 待确认的危险语句；非空即弹框。 */
  const [danger, setDanger] = useState<{ items: DangerItem[]; total: number } | null>(null);
  /** 用户确认后要跑的那一次（语句已从编辑器取出，不能等确认时再取一遍）。 */
  const pendingDanger = useRef<{ tabId: string; mode: SqlRunMode; stmts: RunStmt[]; collectStats: boolean } | null>(null);
  const tabId = tab.id;
  // 切标签就丢掉待确认的弹框：这些语句属于上一个标签的连接，点头确认后
  // 跑到新连接上就是「拿 A 库的 DELETE 删 B 库」。
  useEffect(() => { setDanger(null); pendingDanger.current = null; }, [tabId]);
  useEffect(()=>{const insert=(e:Event)=>{const v=(e as CustomEvent<{tabId:string;text:string}>).detail;if(v.tabId===tab.id) api.current?.insert(v.text);};window.addEventListener("ncforge-db-insert-name",insert);return()=>window.removeEventListener("ncforge-db-insert-name",insert);},[tab.id]);

  const execute = useCallback(
    async (mode: SqlRunMode, stmts: RunStmt[], collectStats: boolean) => {
      const executionScope = { tabId, selected: mode === "auto" && scopeRef.current?.tabId === tabId && scopeRef.current.selected, statements: stmts };
      executingScopes.current.set(tabId, executionScope);
      try {
        const outcome = await runStatements(tabId, stmts, { collectStats });
        if (outcome.failLine && activeRef.current && activeTabId.current === tabId) api.current?.reveal(outcome.failLine);
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
      const found = dangerousStatements(stmts.map((s) => s.text));
      for (const item of found) if (item.finding.advisory) toast(`这条语句不可撤销：${item.finding.verb} ${item.finding.table}`, "warning");
      const blocked = found.filter((item) => !item.finding.advisory);
      if (blocked.length > 0 && tab.connId) {
        // 语句在这一刻已经取出来了：等用户在框里按「仍要执行」时编辑器可能已经改过，
        // 那就不是他确认过的那一条了。
        pendingDanger.current = { tabId, mode, stmts, collectStats };
        setDanger({ items: blocked, total: stmts.length });
        return;
      }
      await execute(mode, stmts, collectStats);
    },
    [execute, tab.connId, tabId],
  );

  const confirmDanger = () => {
    const p = pendingDanger.current;
    pendingDanger.current = null;
    setDanger(null);
    // 双保险：切标签的 effect 已经清过，这里再核一次标签身份
    if (p && p.tabId !== tabId) { toast("标签已切换，这次执行已取消", "info"); return; }
    if (p) void execute(p.mode, p.stmts, p.collectStats);
  };
  const cancelDanger = () => { pendingDanger.current = null; setDanger(null); };

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
      {scope && scope.tabId === tab.id && <SqlOutlineBar statements={scope.statements} onPick={(line) => api.current?.reveal(line)} />}
      {danger && tab.connId && (
        <SqlDangerDialog items={danger.items} total={danger.total} connId={tab.connId} slot={tab.slot ?? null} onCancel={cancelDanger} onConfirm={confirmDanger} />
      )}
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
          <SqlEditor tabId={tab.id} initial={tab.sql} onRun={(m) => void run(m)} apiRef={api} onScope={setScope} visible={active && split.focus !== "results"} />
          <div
            className="dbx-splitbar"
            hidden={split.focus !== "split"}
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整结果区高度"
            tabIndex={0}
            aria-valuemin={split.min}
            aria-valuemax={split.max}
            aria-valuenow={split.height}
            onKeyDown={split.onKeyDown}
            onPointerDown={(e) => {
              e.preventDefault();
              split.startDrag(e.clientY);
            }}
          />
          <ResultPanel tab={tab} height={split.resultHeight} onLocate={line => {
            if (split.focus === "results") split.setFocus("split");
            api.current?.reveal(line);
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
            // 取「光标处那条（有选中则是选中部分）」——与执行、导出 INSERT 同一口径，
            // 免得存下来的片段里混着编辑器里另外十个不相关的查询
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
