import type { Cell } from "./dbApi";
import type { DbTabItem, ResultEntry } from "./dbStore";

// Conservative retained-data estimates, not a claim about the JS engine's exact heap layout.
export const RESULT_BYTES = 16 * 1024 * 1024;
export const TOTAL_RESULT_BYTES = 64 * 1024 * 1024;
export const RESULT_ROWS = 25_000;
export const RESULT_LIMIT_NOTICE = "已达到结果内存上限，当前仅保留部分数据。请使用重新查询导出，或关闭旧结果后重新执行。";
const sizes = new WeakMap<Cell[][], number>();
const rowBytes = (row: Cell[]) => 32 + row.reduce<number>((n, v) => n + (typeof v === "string" ? 24 + v.length * 2 : 16), 0);
export function rowsBytes(rows: Cell[][]): number {
  let size = sizes.get(rows);
  if (size === undefined) { size = rows.reduce((n, row) => n + rowBytes(row), 0); sizes.set(rows, size); }
  return size;
}
export function resultBytes(result: ResultEntry): number {
  return result.sets?.length ? result.sets.reduce((n, set) => n + rowsBytes(set.rows), 0) : rowsBytes(result.rows);
}
export function retainedResultBytes(tabs: DbTabItem[], except?: string): number {
  const arrays = new Set<Cell[][]>();
  for (const tab of tabs) {
    if (tab.id === except) continue;
    if (tab.kind === "sql") tab.results.forEach(result => {
      if (result.sets?.length) result.sets.forEach(set => arrays.add(set.rows));
      else arrays.add(result.rows);
    });
    if (tab.kind === "compare") { arrays.add(tab.before.rows); arrays.add(tab.after.rows); }
  }
  return [...arrays].reduce((sum, rows) => sum + rowsBytes(rows), 0);
}
function fitRows(rows: Cell[][], budget: number): Cell[][] {
  if (rows.length <= RESULT_ROWS && rowsBytes(rows) <= budget) return rows;
  let bytes = 0, length = 0;
  while (length < rows.length && length < RESULT_ROWS) {
    const next = rowBytes(rows[length]);
    if (bytes + next > budget) break;
    bytes += next; length++;
  }
  const kept = rows.slice(0, length); sizes.set(kept, bytes); return kept;
}
export function fitResult(result: ResultEntry, budget: number): ResultEntry {
  if (result.kind !== "rows") return result;
  let remaining = Math.max(0, Math.min(RESULT_BYTES, budget)), limited = false;
  const sets = result.sets?.map(set => {
    const rows = fitRows(set.rows, remaining); remaining -= rowsBytes(rows);
    limited ||= rows !== set.rows;
    return rows === set.rows ? set : { ...set, rows, rowCount: rows.length, hasMore: true };
  });
  const rows = sets?.length ? sets[0].rows : fitRows(result.rows, remaining);
  limited ||= !sets?.length && rows !== result.rows;
  if (limited) return { ...result, rows, sets, hasMore: true, moreError: RESULT_LIMIT_NOTICE, moreRetryable: false };
  // JSON responses can contain a second copy of the first implicit set in `rows`.
  return sets?.length && rows !== result.rows ? { ...result, rows, sets } : result;
}
export function fitResults(results: ResultEntry[], budget: number): ResultEntry[] {
  return results.map(result => { const kept = fitResult(result, budget); budget -= resultBytes(kept); return kept; });
}

/** Bound the copy before allocating it; an old result's row array is never mutated. */
export function appendResultRows(old: Cell[][], page: Cell[][], budget: number): { rows: Cell[][]; limited: boolean } {
  const available = Math.max(0, Math.min(RESULT_BYTES, budget) - rowsBytes(old));
  const added = fitRows(page.slice(0, Math.max(0, RESULT_ROWS - old.length)), available);
  if (!added.length) return { rows: old, limited: page.length > 0 };
  const rows = old.concat(added); sizes.set(rows, rowsBytes(old) + rowsBytes(added));
  return { rows, limited: added.length !== page.length };
}
