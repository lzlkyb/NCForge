import { useEffect, useState } from "react";
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
  useEffect(() => { setText(String(value)); }, [value]);

  const save = async () => {
    const next = Number(text);
    if (!text.trim() || !Number.isInteger(next) || next < 512 || next > 4096) {
      setError("请输入 512–4096 之间的整数。");
      return;
    }
    setError(null);
    // 后端失败时不回填旧值：用户可以直接重试同一份输入。
    if (await onSave(next)) setText(String(next));
  };

  return <div className="settings-memory-field">
    <div className="settings-memory-controls">
      <Input type="number" min={512} max={4096} step={1}
        className="settings-memory-input" aria-label="代码智能内存上限（MB）"
        aria-invalid={!!error} aria-describedby={error ? "lang-memory-validation" : undefined}
        disabled={disabled || pending} value={text}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (!e.nativeEvent.isComposing && e.key === "Enter") { e.preventDefault(); void save(); } }} />
      <span className="text-xs text-muted-foreground">MB</span>
      <Button variant="outline" size="sm" isLoading={pending} loadingText="保存中…" disabled={disabled || pending || text === String(value)}
        onClick={() => void save()}>{pending ? "保存中…" : "保存"}</Button>
    </div>
    {error && <p id="lang-memory-validation" role="alert" className="text-xs text-destructive-ink">{error}</p>}
  </div>;
}
