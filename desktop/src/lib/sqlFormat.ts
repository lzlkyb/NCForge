/**
 * SQL 格式化（`Ctrl+Shift+F`）。
 *
 * 底层用 sql-formatter（语法级排版）：嵌套子查询逐层缩进、join / and 拆行、CASE 展开、
 * 函数参数规整——旧的手写 tokenizer 对括号内一律原样保留，NC 的多层分页 SQL 几乎整坨在
 * 括号里，等于没格式化。这里换成解析器排版。
 *
 * 关键字大小写默认 preserve：团队写法各异，改大小写只会让 SVN 里的 diff 变脏。
 * 方言按连接 JDBC URL 推断（oracle→plsql 等），未知回退标准 sql；国产库无对应方言时
 * 标准 sql 仍能排版嵌套结构。库懒加载，首次格式化才拉独立 chunk，不进首屏。
 *
 * 排版选项（大小写 / 缩进 / 宽度 / 方言覆盖）来自 `lib/sqlFormatPrefs`，设置页可调、本机生效。
 */
import type { FormatOptions, SqlLanguage } from "sql-formatter";
import { formatOptionsOf, getSqlFormatPrefs, type SqlFormatPrefs } from "./sqlFormatPrefs";

/** JDBC 子协议 → sql-formatter 方言。只列语法明确对应的；其余（达梦/金仓/神通等）回退 sql。 */
const JDBC_LANGUAGE: Record<string, SqlLanguage> = {
  oracle: "plsql",
  mysql: "mysql",
  mariadb: "mariadb",
  postgresql: "postgresql",
  sqlserver: "tsql",
  db2: "db2",
  sqlite: "sqlite",
};

export function sqlLanguageOfUrl(url: string): SqlLanguage {
  const sub = /^jdbc:([a-z0-9]+):/i.exec(url.trim())?.[1].toLowerCase() ?? "";
  return JDBC_LANGUAGE[sub] ?? "sql";
}

/** 连接 URL + 偏好里的方言覆盖 → 实际方言。`auto` 时按 URL 推断。 */
export function sqlLanguageOf(url: string, prefs: SqlFormatPrefs = getSqlFormatPrefs()): SqlLanguage {
  return prefs.dialect === "auto" ? sqlLanguageOfUrl(url) : prefs.dialect;
}

/** 解析失败时抛出，由调用方决定提示；不在这里静默吞掉。 */
export async function formatSql(
  sql: string,
  language: SqlLanguage = "sql",
  options: Partial<FormatOptions> = formatOptionsOf(getSqlFormatPrefs()),
): Promise<string> {
  const { format } = await import("sql-formatter");
  return format(sql, { ...options, language });
}
