import { useEffect, useRef, useState } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

/** 数字输入允许空白草稿；只有明确保存后才请求后端，避免清空时误写入 0。 */
export function LangMemoryField({ value, disabled, pending, onSave }: {
  value: number;
  disabled: boolean;
  pending: boolean;
  onSave: (value: number) => Promise<boolean>;
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  useEffect(() => { setText(String(value)); }, [value]);

  const validate = () => !text.trim() || !Number.isInteger(Number(text)) || Number(text) < 512 || Number(text) > 4096
    ? "请输入 512–4096 之间的整数。" : null;
  const reset = () => { setText(String(value)); setError(null); };

  const save = async () => {
    if (disabled || pending || saving.current || text === String(value)) return;
    const next = Number(text);
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    saving.current = true;
    // 后端失败时不回填旧值：用户可以直接重试同一份输入。
    try { if (await onSave(next)) setText(String(next)); }
    finally { saving.current = false; }
  };

  return <div className="settings-memory-field">
    <div className="settings-memory-controls">
      <Input type="number" min={512} max={4096} step={1}
        className="settings-memory-input" aria-label="代码智能内存上限（MB）"
        aria-invalid={!!error} aria-describedby="lang-memory-validation"
        disabled={disabled || pending} value={text}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        onBlur={() => setError(validate())}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || saving.current) return;
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void save(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); reset(); }
        }} />
      <span className="text-xs text-muted-foreground">MB</span>
      <Button variant="outline" size="sm" isLoading={pending} loadingText="保存中…" disabled={disabled || pending || text === String(value)}
        onClick={() => void save()}>{pending ? "保存中…" : "保存"}</Button>
      {text !== String(value) && <Button variant="ghost" size="sm" disabled={disabled || pending} onClick={reset}>还原</Button>}
    </div>
    <p id="lang-memory-validation" role={error ? "alert" : undefined} className={error ? "text-xs text-destructive-ink" : "settings-help"}>
      {error ?? (text !== String(value) ? "待保存 · Enter 保存，Esc 还原" : "512–4096 MB · 修改后保存")}</p>
  </div>;
}
