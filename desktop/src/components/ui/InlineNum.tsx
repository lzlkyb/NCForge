import { useState, useEffect, useRef } from "react";
import { SavedHint } from "./SavedHint";

/** 行内数字输入（带防抖自动保存 + 已保存反馈），供设置页各类数值项复用。 */
export function InlineNum({
  value: initial,
  saved,
  unit,
  onSave,
  ariaLabel,
}: {
  value: number;
  saved: boolean;
  unit: string;
  onSave: (v: number) => Promise<void>;
  /** 读屏标签：不带的话读屏只报「数字输入框」，用户不知道在改什么。 */
  ariaLabel?: string;
}) {
  const [value, setValue] = useState(initial);
  const initialized = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!initialized.current) {
      setValue(initial);
      initialized.current = initial !== 0;
    }
  }, [initial]);
  // 卸载即销定时器：否则800ms 到点后 onSave 会在已卸载组件上跑，
  // 回调里的父组件 setState 触发 React 的"卸载后更新"警告。
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );
  const handleChange = (v: number) => {
    setValue(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // 先清 ref 再保存：定时器到点后 ref 若残留旧 id，随后 blur 会
      // clearTimeout（对已触发定时器是 no-op）+ 再 onSave 一次——同一值保存两遍。
      debounceRef.current = undefined;
      onSave(v);
    }, 800);
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        className="s-input"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => handleChange(Number(e.target.value))}
        onBlur={() => {
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            onSave(value);
          }
        }}
      />
      <span className="s-unit">{unit}</span>
      {saved && <SavedHint iconOnly />}
    </div>
  );
}
