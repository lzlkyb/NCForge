import type { Cell, ColumnMeta } from "../../lib/dbApi";
import type { RowChange } from "../../lib/dbOptimisticEdit";
import { ChangeReview } from "./ChangeReview";

/**
 * 变更摘要：结构化 diff（ChangeReview）+ 将要执行的语句（含绑定参数）。
 *
 * 表页「复核修改 / SQL」的就地展开与结果页写回弹窗共用这一块——两边的
 * 执行顺序说明、参数展示口径不会各自走偏。
 * `changes` 为空时整块不渲染（调用方此时也不该给出容器）。
 */
export function DbChangeSummary({ changes, columns, rows, pk, zh, disabled, onUndo }: {
  changes: RowChange[];
  columns: ColumnMeta[];
  rows: Cell[][];
  pk: string[];
  zh?: Record<string, string>;
  disabled?: boolean;
  /** 撤销单条变更：调用方按 kind 决定是清格子还是还原草稿行。 */
  onUndo: (change: RowChange) => void;
}) {
  if (changes.length === 0) return null;
  return (
    <>
      <ChangeReview changes={changes} columns={columns} rows={rows} pk={pk} zh={zh} disabled={disabled} onUndo={onUndo} />
      <pre className="dbx-ddl" style={{ flex: "none", maxHeight: 140, borderTop: "1px solid hsl(var(--border))" }}>
        {changes.map(c => `${c.sql};\n-- 绑定参数: ${JSON.stringify(c.params)}`).join("\n")}
      </pre>
    </>
  );
}
