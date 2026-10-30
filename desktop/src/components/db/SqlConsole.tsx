import { useCallback, useRef, useState } from "react";
import { toast } from "../ui/toast";
import { SqlToolbar } from "./SqlToolbar";
import { SqlEditor, type SqlEditorApi } from "./SqlEditor";
import { TxBar } from "./TxBar";
import { ResultPanel } from "./ResultPanel";
import { HistoryDrawer } from "./HistoryDrawer";
import { explain, runStatements } from "../../lib/dbActions";
import { sqlTabOf, type SqlTab } from "../../lib/dbStore";

/** SQL 控制台：工具条 / 事务条 / 编辑器 / 可拖高度的结果区 / 历史抽屉。 */
export function SqlConsole({ tab }: { tab: SqlTab }) {
  const api = useRef<SqlEditorApi | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [resH, setResH] = useState(300);
  const [history, setHistory] = useState(false);
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
        onExplain={onExplain}
        onFormat={() => api.current?.format()}
        historyOpen={history}
        onHistory={() => setHistory(!history)}
      />
      <TxBar connId={tab.connId} />
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
      </div>
    </div>
  );
}
