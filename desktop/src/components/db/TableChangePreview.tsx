import type { Cell, ColumnMeta } from "../../lib/dbApi";
import type { RowChange } from "../../lib/dbOptimisticEdit";
import { ChangeReview } from "./ChangeReview";

/**
 * 「预览 SQL」展开后的两块内容：变更复核表 + 将要执行的语句（含绑定参数）。
 *
 * 抽成独立组件是为了让 `TableData` 只管状态编排、不再铺这段版式。
 * 没有变更就整块不渲染——`sqls` 是由 `changes` 派生的，两者必然同空。
 */
export function TableChangePreview({ changes, sqls, columns, rows, pk, zh, disabled, onUndo }: {
  changes: RowChange[];
  /** 与 `changes` 一一对应的语句文本，只用于展示。 */
  sqls: string[];
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
      {sqls.length > 0 && (
        <pre className="dbx-ddl" style={{ flex: "none", maxHeight: 140, borderTop: "1px solid hsl(var(--border))" }}>
          {changes.map((c) => `${c.sql};\n-- 绑定参数: ${JSON.stringify(c.params)}`).join("\n")}
        </pre>
      )}
    </>
  );
}
