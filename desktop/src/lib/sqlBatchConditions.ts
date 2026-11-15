import type { SqlLanguage } from "sql-formatter";
import { analyzeSql, resolveSqlQualifier, sqlScopeAt, type SqlSource } from "./sqlScope";
import { isSqlName, scanSql, sqlName, type SqlToken } from "./sqlLex";
import { isPlsql, splitStatements } from "./sqlSplit";

export interface SqlBatchTarget {
  source: SqlSource;
  column: string;
  columnRef: string;
  fieldRef: string;
  start: number;
  end: number;
}
const locationHint = "请在 WHERE 字段后，或字段 IN (...) 内选中完整的一列值";
const boundaries = new Set(["WHERE", "ON", "HAVING", "AND", "OR"]);
const afterCondition = new Set(["WHERE", "AND", "OR", "JOIN", "LEFT", "RIGHT", "FULL", "INNER", "OUTER", "CROSS", "GROUP", "ORDER", "HAVING", "CONNECT", "START", "RETURNING", "FOR", "FETCH", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT", "MINUS", ";"]);
const upper = (token?: SqlToken) => token?.text.toUpperCase() ?? "";

function isPredicateStart(tokens: SqlToken[], before: number): boolean {
  while (tokens[before]?.text === "(" || upper(tokens[before]) === "NOT") before--;
  if (!boundaries.has(upper(tokens[before]))) return false;
  if (upper(tokens[before]) !== "AND") return true;
  // BETWEEN's AND joins its endpoints, so it is not a new predicate boundary.
  for (let p = before - 1; p >= 0 && !boundaries.has(upper(tokens[p])); p--) if (upper(tokens[p]) === "BETWEEN") return false;
  return true;
}

/** Mask pasted data before parsing SQL: apostrophes in Excel cells must not change query scope. */
export function sqlBatchTarget(sql: string, start: number, end: number, dialect: SqlLanguage): SqlBatchTarget {
  if (start < 0 || end > sql.length || start >= end) throw new Error("请先选中从 Excel 粘贴的一列值");
  const scanned = scanSql(sql.slice(0, start), dialect);
  if (scanned.state.mode !== "plain") throw new Error(locationHint);
  const tokens = scanned.tokens.filter(t => t.kind !== "space");
  let p = tokens.length - 1, replaceEnd = end, inList = false;
  if (tokens[p]?.text === "(" && upper(tokens[p - 1]) === "IN") {
    if (upper(tokens[p - 2]) === "NOT") throw new Error("NOT IN 请保留手写条件；此操作生成 IN 条件");
    const close = /^\s*\)/.exec(sql.slice(end));
    if (!close) throw new Error("请选中 IN 括号内的完整一列值");
    replaceEnd += close[0].length; p -= 2; inList = true;
  }
  const columnToken = tokens[p];
  if (!isSqlName(columnToken)) throw new Error(locationHint);
  if (!inList && !/^\s+$/.test(sql.slice(columnToken.end, start))) throw new Error(locationHint);
  let fieldStart = p, qualifier: SqlToken | undefined;
  if (tokens[p - 1]?.text === "." && isSqlName(tokens[p - 2])) { qualifier = tokens[p - 2]; fieldStart -= 2; }
  if (!isPredicateStart(tokens, fieldStart - 1)) throw new Error(locationHint);
  const suffix = scanSql(sql.slice(replaceEnd), dialect).tokens.filter(t => t.kind !== "space");
  // Closing grouping parentheses do not make a following comparison/arithmetic safe.
  const tail = suffix.find(t => t.text !== ")");
  if (tail && !afterCondition.has(upper(tail))) throw new Error(locationHint);
  const masked = sql.slice(0, start) + " ".repeat(end - start) + sql.slice(end);
  const statement = splitStatements(masked).find(s => s.start <= tokens[fieldStart].start && s.end >= replaceEnd);
  if (!statement || isPlsql(statement.text)) throw new Error("请在普通 SQL 查询中转换 IN 条件");
  const analysis = analyzeSql(masked, dialect), scope = sqlScopeAt(analysis, columnToken.start);
  // Only the local single source is safe for an unqualified column; never guess across joins.
  const source = qualifier ? resolveSqlQualifier(analysis, columnToken.start, sqlName(qualifier), qualifier.text) : scope?.sources.length === 1 ? scope.sources[0] : undefined;
  if (!source?.table || analysis.tokens[source.declaration].start > columnToken.start) throw new Error("请使用已确认表的字段；多表查询需写明字段所属别名");
  return { source, column: sqlName(columnToken), columnRef: columnToken.text,
    fieldRef: sql.slice(tokens[fieldStart].start, columnToken.end), start: tokens[fieldStart].start, end: replaceEnd };
}

/** Keep literal spellings and precision; metadata, rather than appearance, decides quoting. */
export function sqlBatchValues(selection: string, type: string): string[] {
  const numeric = /^(?:NUMBER|NUMERIC|DECIMAL|DEC|INTEGER|INT|SMALLINT|BIGINT|TINYINT|FLOAT|DOUBLE(?: PRECISION)?|REAL|BINARY_FLOAT|BINARY_DOUBLE|MONEY|SMALLMONEY)(?:\s*\(|$)/i.test(type.trim());
  const text = /^(?:CHAR|VARCHAR|VARCHAR2|NCHAR|NVARCHAR|NVARCHAR2|TEXT|NTEXT|CITEXT|CHARACTER(?: VARYING)?)(?:\s*\(|$)/i.test(type.trim());
  if (!numeric && !text) throw new Error("此字段类型暂不支持批量 IN 条件，请保留手写值");
  if (selection.includes("\t")) throw new Error("请只选择 Excel 中的一列值");
  const values = new Set<string>();
  for (const line of selection.split(/\r\n|\n|\r/)) {
    let value = line.trim();
    if (!value) continue;
    if (numeric) {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) throw new Error("数值字段含无效数字，请检查选中的值");
    } else {
      // A complete hand-written SQL string on its own row retains its original value.
      if (/^'(?:[^']|'')*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
      value = `'${value.replace(/'/g, "''")}'`;
    }
    values.add(value);
  }
  if (!values.size) throw new Error("选区没有可用值，请选择非空的一列值");
  return [...values];
}

export function sqlBatchCondition(fieldRef: string, values: string[], dialect: SqlLanguage, keywordCase: "upper" | "lower" | "preserve" = "upper"): string {
  const keyword = (value: string) => keywordCase === "lower" ? value.toLowerCase() : value;
  const chunk = dialect === "plsql" ? 1000 : values.length, parts: string[] = [];
  for (let start = 0; start < values.length; start += chunk) parts.push(`${fieldRef} ${keyword("IN")} (${values.slice(start, start + chunk).join(", ")})`);
  // The outer parentheses keep every OR group under the existing AND / NOT predicate.
  return parts.length > 1 ? `(${parts.join(`\n ${keyword("OR")} `)})` : parts[0];
}
