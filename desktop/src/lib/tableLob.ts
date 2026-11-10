import { sqlLiteral } from "./resultExport";
import type { Cell, ColumnMeta } from "./dbApi";

/**
 * 表页「加载完整值」的行定位 SQL：按主键单行反查。
 *
 * 不重跑分页 SQL —— 那一层带 `:1` 绑定参数和外层 `rownum`，拿不到绑定时会把占位符
 * 原样发出去；而且页内行号只对当前这一页有意义。主键条件不受排序与翻页影响。
 * 定位不到（没主键 / 主键为 NULL）返回 null，调用方就不给「加载完整值」入口。
 */
export function rowLocatorSql(table: string, columns: ColumnMeta[], row: Cell[] | undefined, pk: string[]): string | null {
  if (!row || pk.length === 0) return null;
  const conds: string[] = [];
  for (const name of pk) {
    const i = columns.findIndex(c => c.name.toUpperCase() === name.toUpperCase());
    const value = i >= 0 ? row[i] : null;
    if (i < 0 || value === null || value === undefined) return null;
    conds.push(`${columns[i].name.toLowerCase()} = ${sqlLiteral(value, columns[i].type)}`);
  }
  return `select * from ${table.toLowerCase()} where ${conds.join(" and ")}`;
}
