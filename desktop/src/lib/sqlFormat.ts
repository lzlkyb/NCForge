/**
 * SQL 格式化（`Ctrl+Shift+F`）。
 *
 * 底层用 sql-formatter 识别方言和语法边界，再按阅读布局收拢完整字段与短子句。
 * 保留结构展开选项；字符串、注释和不确定的结构不能因为收拢布局而改变。
 *
 * 关键字大小写默认 preserve：团队写法各异，改大小写只会让 SVN 里的 diff 变脏。
 * 方言按连接 JDBC URL 推断（oracle→plsql 等），未知回退标准 sql；国产库无对应方言时
 * 标准 sql 仍能排版嵌套结构。库懒加载，首次格式化才拉独立 chunk，不进首屏。
 *
 * 排版选项（大小写 / 缩进 / 宽度 / 方言覆盖）来自 `lib/sqlFormatPrefs`，设置页可调、本机生效。
 */
import type { SqlLanguage } from "sql-formatter";
import { formatOptionsOf, getSqlFormatPrefs, type SqlFormatPrefs, type SqlFormattingOptions } from "./sqlFormatPrefs";
import { readingLayout } from "./sqlReadingLayout";
import { scanSql } from "./sqlLex";
import { assertSqlFormatPreserves, mysqlDelimiterRegions, preserveSqlFormatEdges } from "./sqlFormatSafety";

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
  options: SqlFormattingOptions = formatOptionsOf(getSqlFormatPrefs()),
): Promise<string> {
  const prefs = getSqlFormatPrefs();
  const { layout = prefs.layout, lineWidth = prefs.lineWidth, ...engineOptions } = options;
  const { format, formatDialect, plsql } = await import("sql-formatter");
  const config = { ...engineOptions, ...(layout === "reading" ? { indentStyle: "standard" as const, useTabs: false, expressionWidth: lineWidth } : {}) };
  const formatQuery = (input: string): string => {
    const original = scanSql(input, language);
    const ranges = language === "plsql" ? original.tokens.filter(token => token.kind === "operator" && token.text === "..") : [];
    let expanded: string;
    if (ranges.length) {
      // The formatter's number rule greedily matches "1." in "1..3". Separate only the
      // real Oracle range tokens before tokenization and render them as dense operators.
      let prepared = "", offset = 0;
      for (const range of ranges) {
        prepared += input.slice(offset, range.start) + " .. ";
        offset = range.end;
      }
      prepared += input.slice(offset);
      expanded = formatDialect(prepared, { ...config, dialect: {
        ...plsql,
        tokenizerOptions: {
          ...plsql.tokenizerOptions,
          operators: [...(plsql.tokenizerOptions.operators ?? []), ".."],
          reservedKeywordPhrases: [...(plsql.tokenizerOptions.reservedKeywordPhrases ?? []), "END LOOP", "END IF"],
        },
        formatOptions: { ...plsql.formatOptions, alwaysDenseOperators: [...(plsql.formatOptions?.alwaysDenseOperators ?? []), ".."] },
      } });
    } else expanded = format(input, { ...config, language });
    const result = layout === "reading" ? readingLayout(expanded, language, lineWidth, engineOptions.tabWidth ?? 2) : expanded;
    assertSqlFormatPreserves(input, original, result, language, engineOptions);
    return result;
  };
  const protectedRegions = mysqlDelimiterRegions(sql, language);
  if (!protectedRegions.length) return formatQuery(sql);
  const formatSurrounding = (text: string) => {
    const body = text.trim();
    return body ? preserveSqlFormatEdges(text, formatQuery(body)) : text;
  };
  let output = "", offset = 0;
  for (const region of protectedRegions) {
    output += formatSurrounding(sql.slice(offset, region.start)) + sql.slice(region.start, region.end);
    offset = region.end;
  }
  return output + formatSurrounding(sql.slice(offset));
}
