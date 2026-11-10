import { useMemo } from "react";
import { friendlyDbError, isLobPreview } from "../lib/db";
import type { Cell, ColumnMeta } from "../lib/dbApi";
import { deleteChange, insertChange, optimisticChanges, planWriteBack, type RowChange } from "../lib/dbOptimisticEdit";
import type { DraftRow } from "../lib/tableRows";

interface PlanPage {
  columns: ColumnMeta[];
  rows: Cell[][];
}

/**
 * 表页的待写回清单（纯派生，不执行任何请求）。
 *
 * 从 `TableData` 抽出来有两个原因：组件体量门禁，以及这段曾在 render 期直接
 * 调用并让异常穿到 React——一改到 8K 预览的 CLOB，整页被错误边界替换，
 * 连未写回的改动一起丢。这里统一 catch，把原因交给状态条显示。
 *
 * 原值是预览的格子不进计划（其余改动照常写回），并单独计数给用户看。
 */
export function useTablePlan({ tableRef, page, pk, changed, drafts, deleted }: {
  tableRef: string;
  page: PlanPage | null;
  pk: string[];
  changed: Map<string, Cell>;
  drafts: DraftRow[];
  deleted: number[];
}) {
  const filtered = useMemo(() => {
    if (!page || changed.size === 0) return { writeChanged: changed, previewCount: 0 };
    let bad = 0;
    const map = new Map<string, Cell>();
    for (const [key, value] of changed) {
      const [r, c] = key.split(":").map(Number);
      if (isLobPreview(page.rows[r]?.[c] ?? null)) { bad++; continue; }
      map.set(key, value);
    }
    return { writeChanged: bad ? map : changed, previewCount: bad };
  }, [changed, page]);

  const planned = useMemo(() => {
    if (!page) return { changes: [] as RowChange[], error: "" };
    try {
      return {
        changes: planWriteBack([
          ...deleted.map(r => deleteChange(tableRef, page.columns, page.rows[r], pk, r)),
          ...optimisticChanges(tableRef, page.columns, page.rows, pk, filtered.writeChanged),
          // 刚点「新增行」还没填任何值时不能生成 insert（会拼出一条没有列名的 SQL）；
          // 这一行在界面上仍然显示，填了第一个值之后才进入待写回清单。
          ...drafts.flatMap((d, i) => d.values.size ? [insertChange(tableRef, page.columns, d.values, page.rows.length + i)] : []),
        ]),
        error: "",
      };
    } catch (e) {
      return { changes: [] as RowChange[], error: friendlyDbError(e) };
    }
  }, [page, deleted, drafts, tableRef, pk, filtered]);

  const error = planned.error || (filtered.previewCount
    ? `有 ${filtered.previewCount} 处改动作用在大文本预览上（只有前 8K），无法直接写回；请用 SQL 更新这些列，其余改动不受影响`
    : "");
  return { changes: planned.changes, error };
}
