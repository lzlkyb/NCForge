import type { Cell, ColumnMeta } from "./dbApi";
import { sqlLiteral } from "./resultExport";

/**
 * 表页的分页查询与写回 SQL（纯函数，可单测）。
 *
 * 分页用 rownum 套两层而不是 `offset … fetch`：后者要 12c，老库还有 11g。
 * 不用桥里的游标翻页：同一连接上 SQL 控制台一执行，游标就被换掉了。
 */

export const PAGE = 200;
export const RN = "RN__";

export function pageSql(table: string, where: string, order: string, page: number): string {
  const w = where.trim() ? ` where ${where.trim()}` : "";
  const o = order.trim() ? ` order by ${order.trim()}` : "";
  const lo = page * PAGE;
  return `select * from (select a.*, rownum ${RN} from (select * from ${table}${w}${o}) a where rownum <= ${lo + PAGE + 1}) where ${RN} > ${lo}`;
}

/** 去掉分页用的行号列；多取的一行只用来判断还有没有下一页。 */
export function stripPage(columns: ColumnMeta[], rows: Cell[][]): { columns: ColumnMeta[]; rows: Cell[][]; hasNext: boolean } {
  const k = columns.findIndex((c) => c.name.toUpperCase() === RN);
  const cols = k < 0 ? columns : columns.filter((_, i) => i !== k);
  const body = rows.slice(0, PAGE).map((r) => (k < 0 ? r : r.filter((_, i) => i !== k)));
  return { columns: cols, rows: body, hasNext: rows.length > PAGE };
}

/** 把改过的格子按行合并成 update 语句，用主键定位。主键列有 NULL 的行不生成（定位不到唯一行）。 */
export function updateSql(table: string, columns: ColumnMeta[], rows: Cell[][], pk: string[], changed: Map<string, Cell>): string[] {
  const byRow = new Map<number, [number, Cell][]>();
  for (const [key, v] of changed) {
    const [r, c] = key.split(":").map(Number);
    byRow.set(r, [...(byRow.get(r) ?? []), [c, v]]);
  }
  const pkIdx = pk.map((p) => columns.findIndex((c) => c.name.toUpperCase() === p.toUpperCase()));
  if (pk.length === 0 || pkIdx.some((i) => i < 0)) return [];
  const out: string[] = [];
  for (const [r, cells] of [...byRow].sort((a, b) => a[0] - b[0])) {
    const row = rows[r];
    if (!row || pkIdx.some((i) => row[i] === null)) continue;
    const set = cells
      .sort((a, b) => a[0] - b[0])
      .map(([c, v]) => `${columns[c].name.toLowerCase()} = ${sqlLiteral(v, columns[c].type)}`)
      .join(", ");
    const where = pkIdx.map((i) => `${columns[i].name.toLowerCase()} = ${sqlLiteral(row[i], columns[i].type)}`).join(" and ");
    out.push(`update ${table.toLowerCase()} set ${set} where ${where}`);
  }
  return out;
}
