// 调试面板的「监视」区：输入表达式 → debug_evaluate。
//
// 表达式挂在调试会话里（`lib/debugSession`），切到日志页再切回来不会丢；
// 每次停住或换栈帧都会按当前帧重算——DAP 的求值上下文跟着 frame 走，
// 不重算就会拿旧帧的值冒充新帧。
import { useState } from "react";
import { Icon } from "../ui/icon";
import {
  MAX_DEBUG_WATCHES,
  addWatch,
  removeWatch,
  type DebugWatch as Watch,
} from "../../lib/debugSession";

export function DebugWatch({ paused, watches }: { paused: boolean; watches: Watch[] }) {
  const [draft, setDraft] = useState("");
  const full = watches.length >= MAX_DEBUG_WATCHES;
  const canAdd = paused && !full && draft.trim().length > 0;

  const submit = () => {
    if (!canAdd) return;
    void addWatch(draft);
    setDraft("");
  };

  return (
    <>
      <div className="dbg-watch-form">
        <input
          className="dbg-watch-input"
          value={draft}
          placeholder={paused ? "表达式，如 vo.getCode()" : "暂停后可求值"}
          spellCheck={false}
          disabled={!paused || full}
          title={full ? `最多 ${MAX_DEBUG_WATCHES} 条监视表达式` : "按 Enter 添加监视"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button type="button" className="dbg-icon-btn" disabled={!canAdd} title="添加监视" onClick={submit}>
          <Icon name="plus" size={13} />
        </button>
      </div>
      {watches.length === 0 ? (
        <div className="dbg-empty">暂停后输入表达式，每次停住自动重算。</div>
      ) : (
        <div className="dbg-watch-list">
          {watches.map((w) => (
            <div className="dbg-watch" key={w.expression} title={w.error ?? w.result ?? w.expression}>
              <span className="dbg-watch-expr">{w.expression}</span>
              <span className="dbg-var-eq">=</span>
              {w.evaluating ? (
                <span className="dbg-watch-val">求值中…</span>
              ) : w.error ? (
                <span className="dbg-watch-err">{w.error}</span>
              ) : (
                <span className="dbg-watch-val">
                  {w.result ?? "—"}
                  {w.type ? <span className="dbg-watch-type"> {w.type}</span> : null}
                </span>
              )}
              <button
                type="button"
                className="dbg-icon-btn dbg-watch-del"
                title="移除监视"
                onClick={() => removeWatch(w.expression)}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
