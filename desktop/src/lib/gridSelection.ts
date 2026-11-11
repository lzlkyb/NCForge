import type { selectionBounds } from "./gridViewport";
import type { Selection } from "./dbResultTools";
type Bounds = ReturnType<typeof selectionBounds>;
export function allResultSelection(order: number[], visible: number[]): Selection | null {
  if (!order.length || !visible.length) return null;
  return { anchor: { r: order[0], c: visible[0] }, end: { r: order[order.length - 1], c: visible[visible.length - 1] } };
}

/** Borders belong to logical row/column indices, never the rendered viewport edge. */
export function gridSelectionCell(bounds: Bounds, row: number, column: number, active: boolean) {
  const selected = !!bounds && row >= bounds.rowStart && row <= bounds.rowEnd && column >= bounds.colStart && column <= bounds.colEnd;
  const edges = selected ? [row === bounds.rowStart && "top", row === bounds.rowEnd && "bottom", column === bounds.colStart && "left", column === bounds.colEnd && "right"].filter(Boolean).join(" ") : "";
  return { "data-cell": selected || undefined, "aria-selected": selected || undefined,
    "data-range-edges": edges || undefined, "data-active-cell": active || undefined };
}
export function gridSelectionHeading(bounds: Bounds, index: number, axis: "row" | "column") {
  return !!bounds && (axis === "row" ? index >= bounds.rowStart && index <= bounds.rowEnd : index >= bounds.colStart && index <= bounds.colEnd) || undefined;
}

/**
 * 选区里真正可编辑的格子（行、列都用原始下标）。
 *
 * 右键「设为 NULL」与「撤销改动」要作用到整个选区，而选区里可能混着主键列、
 * 只读类型的列——那些跳过，不能一条动作把不可写的位置也算进待写回清单。
 */
export function selectedEditableCells(
  bounds: Bounds,
  order: number[],
  visible: number[],
  canEdit: (col: number, row: number) => boolean,
): { row: number; col: number }[] {
  if (!bounds) return [];
  const out: { row: number; col: number }[] = [];
  for (let i = bounds.rowStart; i <= bounds.rowEnd; i += 1) {
    for (let j = bounds.colStart; j <= bounds.colEnd; j += 1) {
      const row = order[i], col = visible[j];
      if (row !== undefined && col !== undefined && canEdit(col, row)) out.push({ row, col });
    }
  }
  return out;
}
