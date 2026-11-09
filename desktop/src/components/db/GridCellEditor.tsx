import { useRef, type CSSProperties } from "react";

/**
 * 正在编辑的单元格：一个贴在原格位置上的 input。
 *
 * 键盘语义与 DBeaver / DataGrip 对齐：`Enter` 提交并下移、`Tab` 提交并右移
 * （带 `Shift` 反向）、`Esc` 放弃本次输入。方向由 `onCommitMove` 处理，
 * 不传就退回「提交并留在原格」。
 *
 * `done` 这个标记是必需的：按 Enter 后 `setEditing(null)` 会把这个 input 卸掉，
 * 卸载引发的 blur 不能再提交一次（否则第二次提交用的还是旧值）。
 */
export function GridCellEditor({ id, colIndex, style, value, changed, selected, onChange, onCommit, onCancel, onCommitMove }: {
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
          if (e.key === "Enter") { e.preventDefault(); finish(() => move(e.shiftKey ? -1 : 1, 0)); }
          else if (e.key === "Tab") { e.preventDefault(); finish(() => move(0, e.shiftKey ? -1 : 1)); }
          else if (e.key === "Escape") { e.preventDefault(); finish(onCancel); }
        }}
      />
    </div>
  );
}
