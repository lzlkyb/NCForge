import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 大文本编辑框（Shift+Enter）。
 *
 * 单元格只有几十 px 宽，在里面改长文本等于盲打：所以 Shift+Enter 弹出这个框，
 * 但它**不直接提交**——「应用」只把值写回单元格编辑框，用户还要按 Enter 才落进
 * 待写回清单。多一层确认是故意的：长文本改错一次的代价比多按一次键大得多。
 *
 * `Ctrl+Enter` 应用、`Esc` 取消；Enter 在 textarea 里就是换行，不拦。
 */
export function GridTextEditor({ column, value, onChange, onClose }: {
  column: string;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const apply = () => { onChange(text); onClose(); };
  return createPortal(
    <div className="dbx-textedit-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dbx-textedit" role="dialog" aria-modal="true" aria-label={`编辑 ${column}`}
        onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}>
        <div className="dbx-textedit-head">
          <span className="dbx-textedit-col">{column}</span>
          <span className="dbx-muted">{text.length} 字符</span>
        </div>
        <textarea
          ref={ref}
          className="dbx-textedit-area"
          value={text}
          spellCheck={false}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); }
          }}
        />
        <div className="dbx-textedit-foot">
          <span className="dbx-muted">Ctrl+Enter 应用 · Esc 取消</span>
          <span className="dbx-sp" />
          <button type="button" className="dbx-btn ghost" onClick={onClose}>取消</button>
          <button type="button" className="dbx-btn pri" onClick={apply}>应用</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
