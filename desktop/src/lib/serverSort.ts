/**
 * 「用此列让数据库重排」（A3）。
 *
 * 结果表默认的排序只作用于**已经取到界面上的那些行**（`resultView.viewOrder`）——
 * 看起来整表有序，其实第 501 行可能该排第一。这个文件负责把「重排」变成一次真的重查：
 * 把原 SQL 包进子查询再 `order by`。
 *
 * 为什么包一层，而不是往末尾追加 `order by`：
 * - 原 SQL 可能已经有 `order by`（追加就是第二个 order by，ORA-00933）；
 * - 可能是 `union all` 两段（追加只作用于最后一段）；
 * - 可能带 `fetch first` / `for update`（追加位置全错）。
 * `select * from (原SQL) order by 列 方向` 对单条 SELECT 是普遍正确的。
 */

/** 列名引号化：Oracle 未加引号的标识符一律按大写存，所以只有全大写且只含
 *  `A-Z0-9_$#` 才不加引号；其它（小写别名、含空格/中文）必须加 `"` 并按原始大小写匹配。 */
export function quoteIdent(name: string): string {
  const n = name.trim();
  if (/^[A-Z][A-Z0-9_$#]*$/.test(n)) return n;
  return `"${n.replace(/"/g, '""')}"`;
}

/** 去掉末尾分号与 `--` 行尾注释留下的空白（只用于判断，不改变原语句）。 */
function tail(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "").trim();
}

/**
 * 这条语句能不能让数据库重排。
 *
 * 只认**单条** SELECT / WITH：DML、PL/SQL 块、多条语句一律不行——
 * 包一层子查询要么语法错，要么变成「只对最后一段排序」这种更糟的假象。
 */
export function canServerSort(sql: string): boolean {
  const s = tail(sql);
  if (!s) return false;
  // 语句中间的分号 = 多条语句（字面量里的分号交给调用方先用 splitStatements 排除）
  if (/;\s*\S/.test(s)) return false;
  if (/\bfor\s+update\b/i.test(s)) return false;
  return /^(select|with)\b/i.test(s);
}

/**
 * 包一层子查询 + `order by`。不能重排时返回 `null`（调用方据此禁用菜单项并说明原因）。
 *
 * `column` 用结果集的列名：包一层子查询后，外层能引用的就是子查询的输出列，
 * 与用户在结果表里看到的名字一致。
 */
export function orderBySql(sql: string, column: string, dir: "asc" | "desc"): string | null {
  if (!canServerSort(sql)) return null;
  const body = tail(sql);
  const col = quoteIdent(column);
  if (!col) return null;
  const dirSql = dir === "asc" ? "asc" : "desc";
  // 行尾不加分号：执行层会自己处理（`db_rust::normalize` 会去掉）
  return `select * from (\n${body}\n) order by ${col} ${dirSql}`;
}

/** 菜单项文案：说清「这一下会重查整表」，而不是让人以为只是换个显示顺序。 */
export function serverSortLabel(column: string, dir: "asc" | "desc"): string {
  return `用 ${column} ${dir === "asc" ? "升序" : "降序"}重排并重查（作用全表）`;
}
