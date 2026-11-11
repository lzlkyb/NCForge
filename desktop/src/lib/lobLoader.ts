import { dbApi } from "./dbApi";
import type { LobLoader } from "../components/db/CellDetail";
import type { LobSource } from "../components/db/ResultTable";

/**
 * 把「结果表的 LOB 上下文 + 当前行」变成一个取数器。
 *
 * - 普通查询：按原 SQL 的行下标取第 `row + 1` 行；
 * - 表页 / 自定义定位：`sqlForRow` 返回只含一行的 SQL，所以行号固定 0；
 * - 这一行定位不到（主键为空 / 没主键）时 `canLoad = false`，而不是拿错行。
 */
export function lobLoaderFor(lob: LobSource | undefined, row: number | null, column: string, binaryIndex?: number): LobLoader | undefined {
  if (!lob || row === null || !column) return undefined;
  const locate = () => binaryIndex !== undefined ? lob.binarySqlForRow?.(row, binaryIndex)
    : lob.sqlForRow ? lob.sqlForRow(row) : lob.sql;
  return {
    canLoad: !!locate(),
    load: async () => {
      const sql = locate();
      if (!sql) throw new Error("这一行没有可用的定位条件，无法加载完整值；请直接查询该表");
      const r = binaryIndex !== undefined
        ? await dbApi.lobValue(lob.connId, sql, 0, column, lob.slot ?? null, undefined, true)
        : await dbApi.lobValue(lob.connId, sql, lob.sqlForRow ? 0 : row, column, lob.slot ?? null);
      return { value: r.value, chars: r.chars, truncated: r.truncated };
    },
  };
}
