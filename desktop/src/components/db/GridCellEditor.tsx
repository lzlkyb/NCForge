import { useRef, type CSSProperties } from "react";

/**
 * 正在编辑的单元格：一个贴在原格位置上的 input。
 *
 * 键盘语义与 DBeaver / DataGrip 对齐：`Enter` 提交并下移、`Tab` 提交并右移
 * （`Shift+Tab` 反向）、`Esc` 放弃本次输入。方向由 `onCommitMove` 处理，
 * 不传就退回「提交并留在原格」。
 * `Shift+Enter` / `Alt+Enter` / `F2` 打开大文本编辑框（不提交）。
 *
 * `done` 这个标记是必需的：按 Enter 后 `setEditing(null)` 会把这个 input 卸掉，
 * 卸载引发的 blur 不能再提交一次（否则第二次提交用的还是旧值）。
 */
export function GridCellEditor({ id, colIndex, style, value, changed, selected, onChange, onCommit, onCancel, onCommitMove, onExpand }: {
  id: string;
  /** 可见列序号（从 0 起），用于 aria-colindex；行号列占 1。 */
  colIndex: number;
  style: CSSProperties;
  value: string;
  changed: boolean;
  selected: { "data-cell"?: boolean; "aria-selected"?: boolean; "data-range-edges"?: string; "data-active-cell"?: boolean };
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  /** 提交并按方向移动（行、列）。 */
  onCommitMove?: (dr: number, dc: number) => void;
  /** Shift+Enter / Alt+Enter / F2 打开大文本编辑框；不传 = 这个网格不支持。 */
  onExpand?: () => void;
}) {
  const done = useRef(false);
  const finish = (action: () => void) => { done.current = true; action(); };
  const move = (dr: number, dc: number) => { if (onCommitMove) onCommitMove(dr, dc); else onCommit(); };
  return (
    <div id={id} className={`dbx-gc${changed ? " chg" : ""}`} {...selected} data-editing data-focus-container role="gridcell" aria-colindex={colIndex} style={{ ...style, padding: 0 }}>
      <input
        className="dbx-gedit"
        autoFocus
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={() => { if (!done.current) onCommit(); }}
        onKeyDown={e => {
          // Candidate confirmation belongs to the IME, not to the grid editor.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            // Shift+Enter / Alt+Enter = 打开大文本编辑框（不提交）：单元格里改长文本
            // 是盲打。反向移动交给 Shift+Tab，两者不再挤在同一个键上；Alt 是给
            // 「Shift+Enter 被输入法占了」的键盘留的备路，必须和 Shift 同在 Enter
            // 分支里判——放到下面的 else if 会被这个分支先截走，永远到不了。
            if (onExpand && (e.shiftKey || e.altKey)) { onExpand(); return; }
            finish(() => move(1, 0));
          }
          else if (e.key === "Tab") { e.preventDefault(); finish(() => move(0, e.shiftKey ? -1 : 1)); }
          else if (e.key === "Escape") { e.preventDefault(); finish(onCancel); }
          // F2 也进大文本编辑框。放在这里是安全的：F2 不等于 Enter，不会被上面截走。
          else if (onExpand && e.key === "F2") { e.preventDefault(); onExpand(); }
        }}
      />
    </div>
  );
}
