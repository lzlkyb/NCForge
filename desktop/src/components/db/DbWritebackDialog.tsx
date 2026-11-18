import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import type { RowChange } from "../../lib/dbOptimisticEdit";
import { DbChangeSummary } from "./DbChangeSummary";

/**
 * 写回前的「预览并提交」（对齐 DataGrip 的 Preview Pending Changes / DML Preview）。
 *
 * 结果页（SQL 控制台）没有就地展开的空间：点「写回 N 行」先过这一眼 diff 与
 * 生成的语句，确认后才真正执行。表页保留自己的就地展开形态——那边可以
 * 边审边改，弹窗反而会把循环切成两段。
 *
 * 提交动作本身（生产库确认、逐条 execBound、事务计数）仍归调用方的 save()，
 * 这里只管「执行前先给人看」。
 */
export function DbWritebackDialog({ open, changes, columns, rows, pk, zh, saving, onUndo, onUndoAll, onSubmit, onClose }: {
  open: boolean;
  changes: RowChange[];
  columns: ColumnMeta[];
  /** 显示行（含草稿行）：diff 表按行号取主键值。 */
  rows: Cell[][];
  pk: string[];
  zh?: Record<string, string>;
  saving: boolean;
  /** 撤回单条变更（弹窗里逐项撤销）。 */
  onUndo: (change: RowChange) => void;
  /** 撤回全部改动。 */
  onUndoAll: () => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="预览待写回的更改"
      className="w-[var(--w-modal-lg)] rounded-[var(--r-card)] modal-surface p-5"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold">预览待写回的更改</h3>
        <button type="button" className="dbx-btn ghost" onClick={onClose}>关闭</button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        共 {changes.length} 条，按「删 → 改 → 增」顺序执行，中途失败即停止。要改动请关闭本窗在网格里修改；确认无误再提交。
      </p>
      <div className="max-h-[60vh] overflow-auto">
        <DbChangeSummary changes={changes} columns={columns} rows={rows} pk={pk} zh={zh} disabled={saving} onUndo={onUndo} />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="dbx-btn ghost" disabled={saving} onClick={onUndoAll}>撤销全部改动</button>
        <button type="button" className="dbx-btn pri" disabled={saving || !changes.length} onClick={onSubmit} title="写回数据库">
          <Icon name={saving ? "spinner" : "check"} size={12} />
          {saving ? "写回中…" : `提交写回 ${changes.length} 条`}
        </button>
      </div>
    </Modal>
  );
}
