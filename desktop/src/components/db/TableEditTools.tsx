import { DbWritebackBar } from "./DbWritebackBar";

export function TableEditTools({ count, dirty, error, editable, saving, preview, onUndo, onTogglePreview, onSave }: {
  count: number;
  dirty: boolean;
  error?: string;
  editable: boolean;
  saving: boolean;
  preview: boolean;
  onUndo: () => void;
  onTogglePreview: () => void;
  onSave: () => void;
}) {
  return <DbWritebackBar count={count} dirty={dirty} error={error} disabled={!editable} saving={saving} onUndo={onUndo} onSave={onSave}>
    {count > 0 && <button type="button" className="dbx-btn ghost" aria-expanded={preview} disabled={saving} onClick={onTogglePreview}>
      复核修改 / SQL
    </button>}
  </DbWritebackBar>;
}
