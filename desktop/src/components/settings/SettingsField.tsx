import { useEffect, useId, useRef, useState } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { errorTextOf } from "../../lib/friendlyError";
import "../../settings-previews.css";

/** Keep an editable draft until a complete, valid value has been saved. */
export function SettingsField({
  value, onSave, validate, id, ariaLabel, type = "text", unit, placeholder,
  min, max, disabled = false, disabledReason,
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
    try {
      await onSave(submitted);
      if (draft.current === submitted) {
        dirty.current = false;
        setText(submitted);
        setSaved(true);
      }
    } catch (e) {
      setError(errorTextOf(e));
      dirty.current = true;
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return <div className="settings-field">
    <div className="settings-field-controls">
      <Input id={id} type={type} min={min} max={max} step={type === "number" ? 1 : undefined}
        value={text} aria-label={ariaLabel} aria-invalid={!!error || undefined}
        aria-describedby={error || pending || saved || disabledReason ? feedbackId : undefined}
        placeholder={placeholder} disabled={disabled || pending}
        className={type === "number" ? "settings-field-number" : "settings-field-text"}
        onChange={e => {
          dirty.current = true;
          draft.current = e.target.value;
          setText(e.target.value);
          setError(undefined);
          setSaved(false);
        }}
        onBlur={() => void save()}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || saving.current) return;
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void save(); }
          if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation();
            dirty.current = false;
            draft.current = String(value);
            setText(String(value)); setError(undefined);
            setSaved(false);
          }
        }} />
      {unit && <span className="settings-field-unit">{unit}</span>}
      {(text !== String(value) || error) && <Button size="sm" variant="ghost"
        disabled={disabled || pending} onClick={() => void save()}>
        {pending ? "保存中…" : error ? "重试" : "保存"}
      </Button>}
    </div>
    {(error || pending || saved || disabledReason) && <p id={feedbackId}
      className={error ? "settings-field-feedback settings-field-error" : "settings-field-feedback"}
      role={error ? "alert" : pending || saved ? "status" : undefined}>
      {error ?? (pending ? "保存中…" : disabledReason ?? "已保存")}
    </p>}
  </div>;
}

export function integerRange(min: number, max: number, unit: string) {
  return (value: string) => {
    const n = Number(value);
    return value.trim() && Number.isInteger(n) && n >= min && n <= max
      ? undefined : `请输入 ${min}–${max} 范围内的整数（${unit}）`;
  };
}
