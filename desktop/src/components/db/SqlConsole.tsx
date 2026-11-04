import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { toast } from "../ui/toast";
import { SqlToolbar } from "./SqlToolbar";
import { SqlEditor, type SqlEditorApi } from "./SqlEditor";
import { TxBar } from "./TxBar";
import { ResultPanel } from "./ResultPanel";
import { HistoryDrawer } from "./HistoryDrawer";
import { SnippetDrawer } from "./SnippetDrawer";
import { SessionDrawer } from "./SessionDrawer";
import { InsertExportDialog } from "./InsertExportDialog";
import { ValueSearchDialog } from "./ValueSearchDialog";
import { ScriptReplayDialog } from "./ScriptReplayDialog";
import { explain, runStatements } from "../../lib/dbActions";
import { cancelOperation, getOperations } from "../../lib/operations";
import { dbApi } from "../../lib/dbApi";
import { friendlyDbError } from "../../lib/db";
import { guessTable } from "../../lib/resultExport";
import { closeSessionPanel, openSessionPanel, sqlTabOf, useDbSelector, type SqlTab } from "../../lib/dbStore";

/** SQL 控制台：工具条 / 事务条 / 编辑器 / 可拖高度的结果区 / 历史与会话抽屉。 */
import { DbContextBar } from "./DbContextBar";

export function SqlConsole({ tab }: { tab: SqlTab }) {
  const api = useRef<SqlEditorApi | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 拖拽中的清理函数：切标签会卸载这个控制台，监听必须一起摘掉。 */
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const [resH, setResH] = useState(()=>{try{return Number(localStorage.getItem("ncforge-db-result-height")) || 300;}catch{return 300;}});
  const [scope,setScope]=useState("执行当前语句");
  /** 右侧抽屉：历史与片段互斥（同一列位置，同时开就挤成两栏了）。 */
  const [side, setSide] = useState<"history" | "snips" | null>(null);
  // 会话面板是页级状态（按钮在工具条、抽屉在 body 里），放 store 才不用层层回调
  const sessOpen = useDbSelector((s) => s.sessionPanel?.connId === tab.connId && tab.connId != null);
  /** 导出对话框：光标处那条语句 + 猜出来的表名。 */
  const [exp, setExp] = useState<{ sql: string; table: string } | null>(null);
  /** 全库按值反查（连接级工具，从工具条开）。 */
  const [vsOpen, setVsOpen] = useState(false);
  /** 回放 .sql 文件（按名字取文件，不进编辑器）。 */
  const [srOpen, setSrOpen] = useState(false);
  const tabId = tab.id;
  useEffect(()=>{const insert=(e:Event)=>{const v=(e as CustomEvent<{tabId:string;text:string}>).detail;if(v.tabId===tab.id) api.current?.insert(v.text);};window.addEventListener("ncforge-db-insert-name",insert);return()=>window.removeEventListener("ncforge-db-insert-name",insert);},[tab.id]);

  const run = useCallback(
    async (mode: "current" | "script") => {
      const stmts = api.current?.target(mode) ?? [];
      if (stmts.length === 0) {
        toast(mode === "script" ? "编辑器里没有可执行的语句" : "光标处没有语句", "info");
        return;
      }
      const outcome = await runStatements(tabId, stmts);
      if (outcome.failLine) api.current?.reveal(outcome.failLine);
    },
    [tabId],
  );

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
    const task=getOperations().find(o=>o.key===`db.sql:${tab.id}` && o.endedAt===undefined);
    if(task) void cancelOperation(task.id);
    else void dbApi.cancel(tab.connId, tab.slot).catch((e) => toast(`取消失败：${friendlyDbError(e)}`, "error"));
  }, [tab.id,tab.connId, tab.slot]);

  /** 结果区最高能拖到哪：留出工具条与表头，不能让结果区把编辑器整个吃掉。 */
  const maxRes = () => Math.max(90, (bodyRef.current?.clientHeight ?? 600) - 80);

  const dragRes = (startY: number) => {
    const start = resH;
    dragCleanup.current?.();
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      dragCleanup.current = null;
      try {localStorage.setItem("ncforge-db-result-height",String(bodyRef.current?.querySelector(".dbx-res")?.clientHeight ?? resH));}catch{/* 当前高度仍有效。 */}
    };
    const move = (e: PointerEvent) => {
      // 系统取消指针时没有 pointerup（Alt+Tab / 笔离开），buttons 归零兜住
      if (e.buttons === 0) return finish();
      setResH(Math.max(90, Math.min(maxRes(), start + startY - e.clientY)));
    };
    dragCleanup.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  /** 键盘调整分隔条：纯键盘用户也能改结果区高度（ARIA separator 的标准做法）。 */
  const resizeByKey = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowUp") setResH((h) => Math.max(90, Math.min(maxRes(), h + step)));
    else if (e.key === "ArrowDown") setResH((h) => Math.max(90, Math.min(maxRes(), h - step)));
    else if (e.key === "Home") setResH(90);
    else if (e.key === "End") setResH(maxRes());
    else return;
    e.preventDefault();
  };

  return (
    <div className="dbx-console">
      <SqlToolbar
        tab={tab}
        onRun={(m) => void run(m)}
        onStop={onStop}
        onExplain={onExplain}
        onFormat={() => api.current?.format()}
        onExport={onExport}
        onValueSearch={() => setVsOpen(true)}
        onScriptReplay={() => setSrOpen(true)}
        historyOpen={side === "history"}
        onHistory={() => setSide(side === "history" ? null : "history")}
        snipsOpen={side === "snips"}
        onSnips={() => setSide(side === "snips" ? null : "snips")}
        sessionsOpen={sessOpen}
        onSessions={() => (sessOpen ? closeSessionPanel() : openSessionPanel(tab.connId))}
      />
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
      <DbContextBar connId={tab.connId} independent={!!tab.slot} />
      <div className="dbx-read-status" aria-live="polite">Ctrl+Enter：{scope} · Alt+X：执行整个脚本</div>
      <TxBar connId={tab.connId} tabId={tab.id} slot={tab.slot} tx={tab.slot ? tab.tx : undefined} />
      <div className="dbx-console-body">
        <div ref={bodyRef} className="dbx-console-main">
          <SqlEditor tabId={tab.id} initial={tab.sql} onRun={(m) => void run(m)} apiRef={api} onScope={setScope} />
          <div
            className="dbx-splitbar"
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整结果区高度"
            tabIndex={0}
            aria-valuemin={90}
            aria-valuemax={maxRes()}
            aria-valuenow={resH}
            onKeyDown={resizeByKey}
            onPointerDown={(e) => {
              e.preventDefault();
              dragRes(e.clientY);
            }}
          />
          <ResultPanel tab={tab} height={resH} onLocate={line=>api.current?.reveal(line)} />
        </div>
        {side === "history" && tab.connId && (
          <HistoryDrawer
            connId={tab.connId}
            onClose={() => setSide(null)}
            onPick={(sql, runNow) => {
              api.current?.setText(sql);
              // 双击：填回后整段执行（可能是脚本）
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
        {sessOpen && tab.connId && <SessionDrawer connId={tab.connId} onClose={closeSessionPanel} />}
      </div>
    </div>
  );
}
