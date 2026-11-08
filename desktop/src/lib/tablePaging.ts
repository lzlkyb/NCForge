import type { BoundCell, Cell, ColumnMeta } from "./dbApi";
import { PAGE, tableQuerySql } from "./tableEdit";

export interface PageAnchor { key: string; page: number; columns: ColumnMeta[]; rows: Cell[][] }

/** Only default, non-null primary-key order is seekable. Custom SQL keeps the old paginator. */
export function seekPage(table: string, where: string, pk: string[], key: string, page: number, previous: PageAnchor | null): {sql: string; params: BoundCell[]; reverse: boolean} | null {
  if (!previous || previous.key !== key || !pk.length || pk.some(p => !/^[a-z_][a-z_0-9$#]*$/i.test(p))) return null;
  const direction = page - previous.page;
  if (Math.abs(direction) !== 1 || !previous.rows.length) return null;
  const row = direction > 0 ? previous.rows[previous.rows.length - 1] : previous.rows[0];
  const values: BoundCell[] = [];
  for (const name of pk) {
    const index = previous.columns.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
    const column = previous.columns[index], value = row[index];
    if (!column || value == null || typeof value === "boolean") return null;
    if (/^(NUMBER|DECIMAL|INTEGER|FLOAT|BINARY_FLOAT|BINARY_DOUBLE)\b/i.test(column.type)) {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value))) return null;
      values.push({number: String(value)});
    } else if (/^(?:N?VARCHAR2?|N?CHAR)\b/i.test(column.type)) values.push(value);
    else return null; // Date/RAW/LOB keys require explicit type-preserving bind support.
  }
  const params: BoundCell[] = [];
  const compare = direction > 0 ? ">" : "<";
  const predicate = pk.map((name, i) => {
    const terms = pk.slice(0, i).map((p, j) => {params.push(values[j]); return `${p} = ?`;});
    params.push(values[i]); terms.push(`${name} ${compare} ?`);
    return `(${terms.join(" and ")})`;
  }).join(" or ");
  const condition = `${where.trim() ? `(${where.trim()}) and ` : ""}(${predicate})`;
  const order = pk.map(p => `${p} ${direction > 0 ? "asc" : "desc"}`).join(", ");
  return {sql:`select * from (${tableQuerySql(table, condition, order)}) where rownum <= ${PAGE + 1}`,params,reverse:direction < 0};
}
