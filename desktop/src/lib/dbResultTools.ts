import type { Cell, ColumnMeta } from "./dbApi";
import { defaultTransferOptions, serializeTransfer } from "./resultTransfer";
import type { CellPos } from "../components/db/ResultGrid";

export interface Selection { anchor: CellPos; end: CellPos }
export function selectedRows(order: number[], sel: Selection): number[] {
  const a = order.indexOf(sel.anchor.r), b = order.indexOf(sel.end.r);
  return a < 0 || b < 0 ? [] : order.slice(Math.min(a, b), Math.max(a, b) + 1);
}
export function selectedCols(visible: number[], sel: Selection): number[] {
  const a = visible.indexOf(sel.anchor.c), b = visible.indexOf(sel.end.c);
  return a < 0 || b < 0 ? [] : visible.slice(Math.min(a, b), Math.max(a, b) + 1);
}
export function selectionText(rows: Cell[][], order: number[], visible: number[], sel: Selection, value = (r: number, c: number) => rows[r][c]): string {
  const cols = selectedCols(visible, sel);
  if (!cols.length) return "";
  // This legacy callback has no column metadata; copy numeric cells as their supplied text.
  const columns = cols.map((_, i) => ({ name: `COLUMN_${i}`, type: "VARCHAR2", precision: 0, scale: 0 }));
  const selected = selectedRows(order, sel).map(r => cols.map(c => { const cell = value(r, c); return typeof cell === "number" ? String(cell) : cell; }));
  return serializeTransfer({ columns, rows: selected }, { ...defaultTransferOptions("tsv"), header: "none", lineEnding: "crlf" });
}
export interface GridLayout { order: string[]; hidden: string[]; frozen: string[]; widths: Record<string, number>; decoded: string[] }
export const defaultLayout = (): GridLayout => ({ order: [], hidden: [], frozen: [], widths: {}, decoded: [] });
export function loadLayout(key?: string): GridLayout {
  try {
    const v = JSON.parse(localStorage.getItem(`ncforge-db-grid:${key}`) ?? "null");
    if (key && v && [v.order,v.hidden,v.frozen].every(a=>Array.isArray(a) && a.every(n=>typeof n==="string")) && v.widths && typeof v.widths==="object" && Object.values(v.widths).every(w=>typeof w==="number" && Number.isFinite(w) && w>=40 && w<=900))
      // `decoded` 是后加的：老布局里没有这个字段，缺省补空数组，别让下游 `.includes` 崩掉。
      return { order:v.order, hidden:v.hidden, frozen:v.frozen, widths:v.widths,
        decoded: Array.isArray(v.decoded) ? v.decoded.filter((n: unknown) => typeof n === "string") : [] };
  } catch { /* 不影响结果读取。 */ }
  return defaultLayout();
}
export function saveLayout(key: string | undefined, value: GridLayout) { if(key) localStorage.setItem(`ncforge-db-grid:${key}`,JSON.stringify(value)); }
export function gridColumns(columns: ColumnMeta[], layout: GridLayout): number[] {
  const byName = new Map(columns.map((c, i) => [c.name, i]));
  const names = [...new Set([...layout.frozen, ...layout.order, ...columns.map(c => c.name)])];
  return names.filter(n => byName.has(n) && !layout.hidden.includes(n)).map(n => byName.get(n)!);
}
export interface ResultSnapshot { source: string; schema?: string; originTabId?: string; sql: string; at: number; complete: boolean; columns: ColumnMeta[]; rows: Cell[][] }
export interface ResultDiff { added: Cell[][]; removed: Cell[][]; changed: { before: Cell[]; after: Cell[] }[] }
export function compareResults(before: ResultSnapshot, after: ResultSnapshot, keys: string[]): ResultDiff {
  if (!keys.length) throw new Error("请选择能唯一标识记录的字段");
  const names = before.columns.map(c => c.name.toUpperCase());
  const afterIndices = new Map(after.columns.map((column,index) => [column.name.toUpperCase(),index]));
  if (names.length !== new Set(names).size || afterIndices.size !== after.columns.length || after.columns.length !== names.length || names.some(n => !afterIndices.has(n))) throw new Error("两份结果的字段必须一致且不能重名");
  const alignment = names.map(name => afterIndices.get(name)!);
  const aligned = after.rows.map(r => alignment.map(index => r[index]));
  const indexes = keys.map(k => names.indexOf(k.toUpperCase()));
  if (indexes.some(i => i < 0)) throw new Error("对比键不在两份结果中");
  const map = (rows: Cell[][]) => {
    const out = new Map<string, Cell[]>();
    for (const row of rows) {
      if (indexes.some(i => row[i] === null)) throw new Error("对比键包含 NULL，请选择其他字段");
      const k = JSON.stringify(indexes.map(i => row[i]));
      if (out.has(k)) throw new Error("对比键存在重复值，请增加键字段");
      out.set(k, row);
    }
    return out;
  };
  const a = map(before.rows), b = map(aligned);
  return { added: [...b].filter(([k]) => !a.has(k)).map(([,r]) => r), removed: [...a].filter(([k]) => !b.has(k)).map(([,r]) => r), changed: [...b].filter(([k,r]) => a.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(r)).map(([k,r]) => ({before:a.get(k)!,after:r})) };
}
