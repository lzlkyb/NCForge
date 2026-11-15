import { type ReactNode } from "react";
import { Icon } from "../ui/icon";

/** Table pages and editable SQL results use the same draft state and actions. */
export function DbWritebackBar({ count, dirty = count > 0, saving, disabled, error, children, onUndo, onSave }: {
  count: number;
  dirty?: boolean;
  saving: boolean;
  disabled?: boolean;
  error?: string;
  children?: ReactNode;
  onUndo: () => void;
  onSave: () => void;
}) {
  if (!dirty && !saving && !error) return null;
  return <div className="dbx-txbar dbx-writeback-bar" data-tone={error ? "bad" : saving ? "busy" : "warn"}>
    <span role={error ? "alert" : "status"}>{error || (count ? `${count} 行待写回` : "有未写回的草稿")}</span>
    <span className="dbx-sp" />
    {children}
    <button type="button" className="dbx-btn ghost" disabled={saving} onClick={onUndo}>撤销改动</button>
    {count > 0 && <button type="button" className="dbx-btn pri" disabled={disabled || saving || !!error} onClick={onSave} title="写回数据库 · Ctrl+S">
      <Icon name={saving ? "spinner" : "check"} size={12} />
      {saving ? "写回中…" : `写回 ${count} 行`}
    </button>}
  </div>;
}
