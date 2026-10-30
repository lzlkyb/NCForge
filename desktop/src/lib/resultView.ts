import type { Cell, ColumnMeta } from "./dbApi";
import { isNumericType } from "./resultExport";

/** 结果表的本地排序与筛选（不重新查库）。返回显示顺序：原始行号数组。 */

export interface SortState {
  col: number;
  dir: "asc" | "desc";
}

function cmp(a: Cell, b: Cell, numeric: boolean): number {
  // NULL 永远排最后，不论升降序（与 PL/SQL Developer 一致）
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (numeric) {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  }
  return String(a).localeCompare(String(b), "zh-CN");
}

export function viewOrder(rows: Cell[][], columns: ColumnMeta[], filter: string, sort: SortState | null): number[] {
  const q = filter.trim().toLowerCase();
  let order = rows.map((_, i) => i);
  if (q) {
    order = order.filter((i) => rows[i].some((v) => v !== null && String(v).toLowerCase().includes(q)));
  }
  if (sort && sort.col < columns.length) {
    const numeric = isNumericType(columns[sort.col].type);
    const sign = sort.dir === "asc" ? 1 : -1;
    order.sort((i, j) => {
      const a = rows[i][sort.col];
      const b = rows[j][sort.col];
      if (a === null || b === null) return cmp(a, b, numeric);
      return sign * cmp(a, b, numeric) || i - j;
    });
  }
  return order;
}

/** 点表头：未排序 → 升序 → 降序 → 未排序。 */
export function nextSort(cur: SortState | null, col: number): SortState | null {
  if (!cur || cur.col !== col) return { col, dir: "asc" };
  return cur.dir === "asc" ? { col, dir: "desc" } : null;
}

/** 初始列宽：按列名、类型与前 50 行内容估算，夹在 64–320 px。 */
export function initialWidths(columns: ColumnMeta[], rows: Cell[][]): number[] {
  return columns.map((c, k) => {
    let len = Math.max(c.name.length, c.type.length * 0.85);
    for (let i = 0; i < Math.min(rows.length, 50); i++) {
      const v = rows[i][k];
      if (v !== null) len = Math.max(len, String(v).length);
    }
    return Math.round(Math.max(64, Math.min(320, len * 7.4 + 20)));
  });
}
