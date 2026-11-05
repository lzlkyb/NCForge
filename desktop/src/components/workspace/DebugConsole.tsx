// 调试控制台（REPL）：暂停时对当前帧求值，历史留在面板里。
//
// 与「监视」的分工：监视是常驻表达式、每次停住重算；控制台是一次性试算，
// 适合调方法、拼参数、看表达式类型。两条路都走 DAP evaluate，上下文各取 repl/watch。
import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { copyText } from "../../lib/utils";
import {
  clearConsole,
  evaluateConsole,
  type DebugConsoleEntry,
} from "../../lib/debugSession";

export function DebugConsole({
  paused,
  entries,
}: {
  paused: boolean;
  entries: DebugConsoleEntry[];
}) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const expression = draft.trim();
    if (!paused || !expression) return;
    setDraft("");
    void evaluateConsole(expression);
  };

  return (
    <div className="dbg-console">
      <div className="dbg-console-head">
        <span>调试控制台</span>
        <span className="dbg-sp" />
        <button
          type="button"
          className="dbg-icon-btn dbg-hd-btn"
          disabled={entries.length === 0}
          title="清空控制台历史"
          onClick={clearConsole}
        >
          <Icon name="trash" size={11} />
        </button>
      </div>
      <div className="dbg-console-log">
        {entries.length === 0 && (
          <div className="dbg-empty">
            {paused
              ? "输入表达式回车求值；结果只对当前暂停帧有效。"
              : "暂停后可在这里试算表达式。"}
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id} className="dbg-console-row">
            <div className="dbg-console-entry">
              <span className="dbg-console-prompt">›</span>
              <span className="dbg-console-expr">{e.expression}</span>
              <button
                type="button"
                className="dbg-icon-btn dbg-console-copy"
                title="复制结果"
                onClick={() =>
                  void copyText(e.error ?? e.result ?? "", () => toast("已复制结果", "success"))
                }
              >
                <Icon name="copy" size={10} />
              </button>
            </div>
            {e.pending ? (
              <div className="dbg-console-out">求值中…</div>
            ) : e.error ? (
              <div className="dbg-console-out dbg-console-err">{e.error}</div>
            ) : (
              <div className="dbg-console-out">
                {e.result ?? "—"}
                {e.type ? <span className="dbg-console-type"> {e.type}</span> : null}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="dbg-console-input-row">
        <input
          className="dbg-watch-input"
          value={draft}
          placeholder={paused ? "表达式，回车求值" : "暂停后可求值"}
          spellCheck={false}
          disabled={!paused}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button
          type="button"
          className="dbg-icon-btn"
          disabled={!paused || !draft.trim()}
          title="求值"
          onClick={submit}
        >
          <Icon name="play" size={12} />
        </button>
      </div>
    </div>
  );
}
