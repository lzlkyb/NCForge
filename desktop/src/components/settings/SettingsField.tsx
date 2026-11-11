import { useEffect, useId, useRef, useState } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { failureText } from "../../lib/friendlyError";
import "../../settings-previews.css";

/** Keep an editable draft until a complete, valid value has been saved. */
export function SettingsField({
  value, onSave, validate, id, ariaLabel, type = "text", unit, placeholder,
  min, max, disabled = false, disabledReason,
  onDraft,
  suggestions,
}: {
  value: string | number;
  onSave: (value: string) => void | Promise<void>;
  validate?: (value: string) => string | undefined;
  id?: string;
  ariaLabel: string;
  type?: "text" | "number";
  unit?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  disabledReason?: string;
  /** Preview a valid draft without changing the persisted preference. */
  onDraft?: (value: string) => void;
  suggestions?: string[];
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = useRef(false);
  const saving = useRef(false);
  const draft = useRef(text);
  const generatedId = useId();
  const feedbackId = `${id ?? generatedId}-feedback`;

  useEffect(() => {
    // Changes from another entry point must not erase a draft being corrected.
    if (!dirty.current) {
      draft.current = String(value);
      setText(String(value));
    }
  }, [value]);

  const save = async () => {
    if (disabled || saving.current || (!error && draft.current === String(value))) return;
    const submitted = draft.current;
    const invalid = validate?.(submitted);
    if (invalid) { setError(invalid); return; }
    saving.current = true;
    setPending(true);
    setError(undefined);
    setSaved(false);
    try {
      await onSave(submitted);
      if (draft.current === submitted) {
        dirty.current = false;
        const canonical = type === "number" && Number.isFinite(Number(submitted)) ? String(Number(submitted)) : submitted;
        draft.current = canonical;
        setText(canonical);
        setSaved(true);
      }
    } catch (e) {
      setError(failureText("保存", e));
      dirty.current = true;
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  const reset = () => {
    dirty.current = false;
    draft.current = String(value);
    setText(String(value)); setError(undefined); setSaved(false);
    onDraft?.(String(value));
  };

  return <div className="settings-field">
    <div className="settings-field-controls">
      {/* 保存中用 readOnly 而非 disabled：输入保持可聚焦，Enter 保存不会把键盘用户的焦点丢回 body。 */}
      <Input id={id} type={type} min={min} max={max} step={type === "number" ? 1 : undefined}
        list={suggestions ? `${feedbackId}-options` : undefined}
        value={text} aria-label={ariaLabel} aria-invalid={!!error || undefined}
        aria-describedby={feedbackId}
        placeholder={placeholder} disabled={disabled} readOnly={pending} aria-busy={pending || undefined}
        className={type === "number" ? "settings-field-number" : "settings-field-text"}
        onChange={e => {
          dirty.current = e.target.value !== String(value);
          draft.current = e.target.value;
          setText(e.target.value);
          setError(undefined);
          setSaved(false);
          if (!validate?.(e.target.value)) onDraft?.(e.target.value);
        }}
        onBlur={() => {
          if (!dirty.current) return;
          const invalid = validate?.(draft.current);
          // Valid input cannot turn a failed persistence attempt into an apparent success.
          if (invalid) setError(invalid);
        }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || saving.current) return;
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void save(); }
          if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation();
            reset();
          }
        }} />
      {unit && <span className="settings-field-unit">{unit}</span>}
      {(text !== String(value) || error || pending) && <><Button size="sm" variant="outline"
        disabled={disabled || pending} onClick={() => void save()}>
        {pending ? "保存中…" : error ? "重试" : "保存"}
      </Button><Button size="sm" variant="ghost" disabled={disabled || pending} onClick={reset}>还原</Button></>}
    </div>
    {suggestions && <datalist id={`${feedbackId}-options`}>{suggestions.map(item => <option key={item} value={item} />)}</datalist>}
    <p id={feedbackId}
      className={error ? "settings-field-feedback settings-field-error" : "settings-field-feedback"}
      role={error ? "alert" : pending || saved ? "status" : undefined}>
      {error ?? (pending ? "保存中…" : disabledReason ?? (saved ? "已保存" : text !== String(value) ? "待保存 · Enter 保存，Esc 还原" : min != null && max != null ? `${min}–${max}${unit ? ` ${unit}` : ""} · 修改后保存` : "修改后保存"))}
    </p>
  </div>;
}

export function integerRange(min: number, max: number, unit: string) {
  return (value: string) => {
    const n = Number(value);
    return value.trim() && Number.isInteger(n) && n >= min && n <= max
      ? undefined : `请输入 ${min}–${max} 范围内的整数（${unit}）`;
  };
}
