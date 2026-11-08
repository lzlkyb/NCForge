import type { selectionBounds } from "./gridViewport";
type Bounds = ReturnType<typeof selectionBounds>;

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
