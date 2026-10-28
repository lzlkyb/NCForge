import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { splitFileName } from "../../lib/workspace";

/**
 * 树里的内联输入行（新建文件 / 新建文件夹 / 重命名共用一个）。
 *
 * 为什么不弹对话框：建文件是高频小动作，弹窗会打断节奏。删除才需要确认。
 *
 * ✓ / ✕ 按钮用 onMouseDown preventDefault：否则按下按钮时输入框先失焦，
 * 「失焦取消」抢在 click 前面跑，按钮就永远点不到。
 */
export function TreeEditRow({
  initial,
  placeholder,
  selectStem,
  isDir,
  padLeft,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  selectStem: boolean;
  isDir: boolean;
  padLeft: number;
  error: string | null;
  busy: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const { stem } = splitFileName(initial);
    // 重命名只选中主名，扩展名留着不动；其他情况（含新建默认名）整体选中，打字即替换
    if (selectStem && stem.length === initial.length) el.select();
    else if (selectStem) el.setSelectionRange(0, stem.length);
    else el.select();
  }, [initial, selectStem]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onCancel();
    };
    // 延到下一轮事件循环再挂：打开输入行的那次 mousedown 还在冒泡，会立刻把它关掉
    const id = window.setTimeout(() => window.addEventListener("mousedown", onDown, true), 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onCancel]);

  return (
    <>
      <div
        ref={boxRef}
        className="wb-tree-edit"
        style={{ paddingLeft: padLeft }}
        data-bad={error ? true : undefined}
      >
        {/* ✓ / ✕ 放在输入框内部：树只有 240px，放到外面会把深层目录的输入框挤没 */}
        <div className="wb-tree-edit-field">
          <Icon name={isDir ? "folder" : "file"} size={13} className="wb-row-icon" />
          <input
            ref={inputRef}
            className="wb-tree-edit-input"
            value={value}
            placeholder={placeholder}
            disabled={busy}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit(value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              }
            }}
          />
          <button
            type="button"
            className="wb-tree-edit-btn"
            data-tone="ok"
            title="确定（Enter）"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSubmit(value)}
          >
            <Icon name="check" size={12} />
          </button>
          <button
            type="button"
            className="wb-tree-edit-btn"
            data-tone="no"
            title="取消（Esc）"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCancel}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </div>
      {error && (
        <div className="wb-tree-edit-err" style={{ paddingLeft: padLeft + 12 }}>
          {error}
        </div>
      )}
    </>
  );
}
