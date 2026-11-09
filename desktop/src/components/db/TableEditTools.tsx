import { Icon } from "../ui/icon";

/**
 * 表页数据编辑的工具条：新增行、待写回摘要、复核、写回。
 *
 * 单独成组件是为了让 `TableData` 只保留数据流（行草稿 → SQL → 写回），
 * 不再继续长按钮 JSX——组件体量门禁盯的就是这个。
 */
export function TableEditTools({ changed, changedCells, added, deleted, editable, saving, preview, onAdd, onUndo, onTogglePreview, onSave }: {
  changed: number;
  changedCells: number;
  added: number;
  deleted: number;
  editable: boolean;
  saving: boolean;
  preview: boolean;
  onAdd: () => void;
  onUndo: () => void;
  onTogglePreview: () => void;
  onSave: () => void;
}) {
  const total = changed + added + deleted;
  return (
    <>
      <button type="button" className="dbx-btn ghost" disabled={!editable} onClick={onAdd}
        title="在结果末尾插入一行：只写你填过的列，其余列交给数据库默认值">+ 新增行</button>
      {total > 0 && (
        <>
          <span className="meta" style={{ color: "hsl(var(--warning-ink))" }}>
            待写回
            {changed > 0 && ` 修改 ${changed} 行（${changedCells} 个单元格）`}
            {added > 0 && ` 增 ${added}`}
            {deleted > 0 && ` 删 ${deleted}`}
          </span>
          <button type="button" className="dbx-btn ghost" disabled={saving} onClick={onUndo}>撤销改动</button>
          <button type="button" className="dbx-btn ghost" data-on={preview || undefined} disabled={saving} onClick={onTogglePreview}
            title="可选：展开后能看到将要执行的 SQL 与逐行改动，不展开也能直接写回">复核修改 / SQL</button>
          <button type="button" className="dbx-btn pri" disabled={!editable || saving} onClick={onSave}
            title="把上面这些改动写成 UPDATE / DELETE / INSERT 并执行 · Ctrl+S">
            <Icon name={saving ? "spinner" : "check"} size={12} />
            {saving ? "写回中…" : `写回 ${total} 行`}
          </button>
        </>
      )}
    </>
  );
}
