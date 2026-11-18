import type { Cell, ColumnMeta } from "../../lib/dbApi";
import type { RowChange } from "../../lib/dbOptimisticEdit";
import { DbChangeSummary } from "./DbChangeSummary";

/**
 * 表页「复核修改 / SQL」的就地展开内容。
 *
 * 2026-11-17：版式搬进 `DbChangeSummary`，与结果页写回弹窗共用同一块——
 * 两边对执行顺序、绑定参数的展示口径不会各自走偏。原 `sqls` 参数删除：
 * 语句文本本来就取自 `RowChange.sql`，外面再传一份必然同值。
 *
 * 表页保留就地展开（不改成弹窗）：用户可以看着 diff 直接回网格改那一格，
 * 弹窗会把这个「边审边改」的循环切成两段。
 */
export function TableChangePreview({ changes, columns, rows, pk, zh, disabled, onUndo }: {
  changes: RowChange[];
  columns: ColumnMeta[];
  rows: Cell[][];
  pk: string[];
  zh?: Record<string, string>;
  disabled?: boolean;
  /** 撤销单条变更：调用方按 kind 决定是清格子还是还原草稿行。 */
  onUndo: (change: RowChange) => void;
}) {
  return <DbChangeSummary changes={changes} columns={columns} rows={rows} pk={pk} zh={zh} disabled={disabled} onUndo={onUndo} />;
}
