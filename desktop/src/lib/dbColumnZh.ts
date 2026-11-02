import { useEffect, useMemo, useState } from "react";
import type { ColumnMeta } from "./dbApi";
import { dbApi } from "./dbApi";
import { sqlTables } from "./sqlTables";

/**
 * SQL 结果表头的 NC 中文名。
 *
 * 表数据页的中文名来自 `db_meta kind=columns`（按表取结构，里面自带 `zh`）；
 * SQL 控制台跑出来的是**任意结果集**，只能在拿到列名之后反查元数据。
 *
 * 两条硬约束：
 *
 * 1. **只按表查，绝不按列名查。** `code` / `name` / `id` 这种列名几乎每张表都有，
 *    按列名去重只能随便挑一个：`code` 在这张表叫「编码」、在那张表叫「单据号」，
 *    查出来的中文名张冠李戴，比不显示更糟。
 * 2. **查不到就不显示**（表头退回显示类型）。这不是 NC 库、或者结果是
 *    `select 1 from dual` 这类算出来的列，都不该硬凑一个名字。
 *
 * 合并顺序 = 表在 SQL 里出现的顺序（`from` 在前、`join` 在后），同名列以主表为准。
 */

/** 键 `表名|列名` → 中文名。空结果也缓存：连的不是 NC 库时每跑一次都问一遍毫无意义。 */
const cache = new Map<string, Promise<Record<string, string>>>();

/** 连接断开 / 刷新对象时清掉（表结构变了，中文名也可能变）。 */
export function forgetColumnZh(connId: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`${connId}|`)) cache.delete(k);
}

function lookup(connId: string, tables: string[]): Promise<Record<string, string>> {
  const key = `${connId}|${tables.join(",")}`;
  let p = cache.get(key);
  if (!p) {
    p = dbApi.columnNamesZh(connId, tables).then((r) => r.names ?? {});
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/**
 * 带缓存的取数（同一条连接 + 同一批表只问一次）。
 *
 * 单独导出是为了能直接测：hook 里那套 effect 只负责「什么时候问」，
 * 「问什么、怎么合并」应该是纯逻辑。
 */
export function columnZhOf(connId: string, tables: string[]): Promise<Record<string, string>> {
  return lookup(connId, tables);
}

/**
 * 把「表|列」的扁平结果收成「列名 → 中文名」。
 *
 * 表按给定顺序遍历：`from` 的主表排在前，所以同名列（join 进来的字典表也有一列
 * `code`）永远取主表的那个。一列都没命中时返回 `undefined`，让调用方保持「显示类型」。
 */
export function mergeZh(
  flat: Record<string, string>,
  tables: string[],
  cols: string[],
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const t of tables) {
    for (const c of cols) {
      const v = flat[`${t}|${c}`];
      if (v && !out[c]) out[c] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 一次结果集的列中文名。`columns` 变了就重查（缓存命中时不发请求）。
 *
 * 「查不到中文名」静默（不是 NC 库、算出来的列），但**请求本身失败要留痕**：
 * 这两件事在界面上的表现完全一样（表头显示类型），一旦桥那边拼错 JSON，
 * 界面会安静得像功能没做，只能靠 F12 里的这条 warning 分辨。
 */
export function useColumnZh(
  connId: string | null,
  sql: string | null,
  columns: ColumnMeta[],
): Record<string, string> | undefined {
  const tables = useMemo(() => sqlTables([sql ?? ""]).map((t) => t.name.toLowerCase()), [sql]);
  const tablesKey = tables.join(",");
  const colsKey = columns.map((c) => c.name.toLowerCase()).join(",");
  const [zh, setZh] = useState<Record<string, string> | undefined>(undefined);

  useEffect(() => {
    setZh(undefined);
    if (!connId || !tablesKey || !colsKey) return;
    let alive = true;
    lookup(connId, tablesKey.split(",")).then(
      (flat) => {
        if (alive) setZh(mergeZh(flat, tablesKey.split(","), colsKey.split(",")));
      },
      (e) => {
        console.warn("读列中文名失败，表头退回显示类型：", e);
      },
    );
    return () => {
      alive = false;
    };
  }, [connId, tablesKey, colsKey]);

  return zh;
}
