import type { CSSProperties } from "react";

/**
 * 正在编辑的单元格：一个贴在原格位置上的 input。
 *
 * 单独成文件是为了让 `ResultGrid` 的行渲染保持可读（也压住组件体量门禁）：
 * 这里只有「输入 → 提交 / 取消」两件事，选中态与列样式都由调用方给。
 */
export function GridCellEditor({ id, colIndex, style, value, changed, selected, onChange, onCommit, onCancel }: {
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
}) {
  return (
    <div id={id} className={`dbx-gc${changed ? " chg" : ""}`} {...selected} data-editing data-focus-container role="gridcell" aria-colindex={colIndex} style={{ ...style, padding: 0 }}>
      <input
        className="dbx-gedit"
        autoFocus
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={e => {
          // Candidate confirmation belongs to the IME, not to the grid editor.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancel();
        }}
      />
    </div>
  );
}
