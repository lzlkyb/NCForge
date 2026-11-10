import { useMemo } from "react";
import { friendlyDbError, isLobPreview } from "../lib/db";
import type { Cell, ColumnMeta } from "../lib/dbApi";
import { deleteChange, insertChange, optimisticChanges, planWriteBack, type RowChange } from "../lib/dbOptimisticEdit";
import type { DraftRow } from "../lib/tableRows";

/**
 * SQL 结果页的待写回清单。纯派生，不执行请求，也绝不把异常抛给 render。
 *
 * 原值是 8K 预览的格子从计划里剔除（其余改动照常写回），单独计数交给工具条说明；
 * 其他构建错误（主键缺失、空新增等）保留原因，否则工具条会把条数显示成 0、
 * 顺手把「写回」按钮藏掉——用户以为改动没了。
 */
export function useResultSetPlan({ tableRef, columns, baseline, keyCols, rowidCol, sourceName, changed, deleted, rows, drafts }: {
  tableRef: string | null;
  columns: ColumnMeta[];
  baseline: Cell[][];
  /** 定位列在结果里的下标；rowid 定位时为空。 */
  keyCols: number[];
  /** 结果里 ROWID 伪列的下标（有它就按 rowid 定位）。 */
  rowidCol: number;
  /** 结果列下标 → 表列名；重命名列写回的是原表列。 */
  sourceName: (col: number) => string | null;
  changed: Map<string, Cell>;
  deleted: number[];
  rows: Cell[][];
  drafts: DraftRow[];
}) {
  const previews = useMemo(() => {
    const bad = new Set<string>();
    for (const key of changed.keys()) {
      const [r, c] = key.split(":").map(Number);
      if (isLobPreview(baseline[r]?.[c] ?? null)) bad.add(key);
    }
    return bad;
  }, [changed, baseline]);
  const writeChanged = useMemo(
    () => previews.size ? new Map([...changed].filter(([key]) => !previews.has(key))) : changed,
    [changed, previews],
  );

  const planned = useMemo(() => {
    if (!tableRef) return { changes: [] as RowChange[], error: "" };
    const opts = { keyCols, rowidCol: rowidCol >= 0 ? rowidCol : undefined, sourceName };
    try {
      const deletes = deleted.map(r => {
        const row = rows[r];
        if (!row) throw new Error(`第 ${r + 1} 行已不在结果里，不能删除`);
        return deleteChange(tableRef, columns, row, [], r, opts);
      });
      const inserts = drafts.flatMap((d, i) =>
        d.values.size ? [insertChange(tableRef, columns, d.values, rows.length + i, opts)] : []);
      return {
        changes: planWriteBack([
          ...optimisticChanges(tableRef, columns, baseline, [], writeChanged, opts),
          ...deletes,
          ...inserts,
        ]),
        error: "",
      };
    } catch (e) {
      return { changes: [] as RowChange[], error: friendlyDbError(e) };
    }
  }, [tableRef, columns, baseline, keyCols, rowidCol, sourceName, writeChanged, deleted, rows, drafts]);

  const error = planned.error || (previews.size
    ? `有 ${previews.size} 处改动作用在大文本预览上（只有前 8K），无法直接写回；请用 SQL 更新这些列，其余改动不受影响`
    : "");
  return { changes: planned.changes, error };
}
