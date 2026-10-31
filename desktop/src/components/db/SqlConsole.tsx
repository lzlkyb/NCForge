import { useCallback, useRef, useState } from "react";
import { toast } from "../ui/toast";
import { SqlToolbar } from "./SqlToolbar";
import { SqlEditor, type SqlEditorApi } from "./SqlEditor";
import { TxBar } from "./TxBar";
import { ResultPanel } from "./ResultPanel";
import { HistoryDrawer } from "./HistoryDrawer";
import { SessionDrawer } from "./SessionDrawer";
import { InsertExportDialog } from "./InsertExportDialog";
import { explain, runStatements } from "../../lib/dbActions";
import { dbApi } from "../../lib/dbApi";
import { friendlyDbError } from "../../lib/db";
import { guessTable } from "../../lib/resultExport";
import { closeSessionPanel, openSessionPanel, sqlTabOf, useDb, type SqlTab } from "../../lib/dbStore";

/** SQL 控制台：工具条 / 事务条 / 编辑器 / 可拖高度的结果区 / 历史与会话抽屉。 */
export function SqlConsole({ tab }: { tab: SqlTab }) {
  const api = useRef<SqlEditorApi | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [resH, setResH] = useState(300);
  const [history, setHistory] = useState(false);
  // 会话面板是页级状态（按钮在工具条、抽屉在 body 里），放 store 才不用层层回调
  const db = useDb();
  const sessOpen = db.sessionPanel?.connId === tab.connId && tab.connId != null;
  /** 导出对话框：光标处那条语句 + 猜出来的表名。 */
  const [exp, setExp] = useState<{ sql: string; table: string } | null>(null);
  const tabId = tab.id;

  const run = useCallback(
    async (mode: "current" | "script") => {
      const stmts = api.current?.target(mode) ?? [];
      if (stmts.length === 0) {
        toast(mode === "script" ? "编辑器里没有可执行的语句" : "光标处没有语句", "info");
        return;
      }
      const failLine = await runStatements(tabId, stmts);
      if (failLine) api.current?.reveal(failLine);
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
    void dbApi.cancel(tab.connId, tab.slot).catch((e) => toast(`取消失败：${friendlyDbError(e)}`, "error"));
  }, [tab.connId, tab.slot]);

  const dragRes = (startY: number) => {
    const start = resH;
    const max = (bodyRef.current?.clientHeight ?? 600) - 80;
    const move = (e: PointerEvent) => setResH(Math.max(90, Math.min(max, start + startY - e.clientY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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
        historyOpen={history}
        onHistory={() => setHistory(!history)}
        sessionsOpen={sessOpen}
        onSessions={() => (sessOpen ? closeSessionPanel() : openSessionPanel(tab.connId))}
      />
      {exp && tab.connId && (
        <InsertExportDialog
          connId={tab.connId}
          table={exp.table}
          sql={exp.sql}
          onClose={() => setExp(null)}
        />
      )}
      <TxBar connId={tab.connId} tabId={tab.id} slot={tab.slot} tx={tab.slot ? tab.tx : undefined} />
      <div className="dbx-console-body">
        <div ref={bodyRef} className="dbx-console-main">
          <SqlEditor tabId={tab.id} initial={tab.sql} onRun={(m) => void run(m)} apiRef={api} />
          <div
            className="dbx-splitbar"
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整结果区高度"
            onPointerDown={(e) => {
              e.preventDefault();
              dragRes(e.clientY);
            }}
          />
          <ResultPanel tab={tab} height={resH} />
        </div>
        {history && tab.connId && (
          <HistoryDrawer
            connId={tab.connId}
            onClose={() => setHistory(false)}
            onPick={(sql, runNow) => {
              api.current?.setText(sql);
              // 双击：填回后整段执行（可能是脚本）
              if (runNow && sqlTabOf(tabId)) void run("script");
            }}
          />
        )}
        {sessOpen && tab.connId && <SessionDrawer connId={tab.connId} onClose={closeSessionPanel} />}
      </div>
    </div>
  );
}
