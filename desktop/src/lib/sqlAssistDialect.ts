import type { SqlLanguage } from "sql-formatter";
import type { SqlClause } from "./sqlCompletionContext";

interface FunctionInfo { name: string; args: string[]; description: string }
const common: FunctionInfo[] = [
  { name: "COUNT", args: ["expression"], description: "统计行数或非空值" },
  { name: "SUM", args: ["expression"], description: "求和" }, { name: "AVG", args: ["expression"], description: "平均值" },
  { name: "MAX", args: ["expression"], description: "最大值" }, { name: "MIN", args: ["expression"], description: "最小值" },
  { name: "COALESCE", args: ["value", "fallback"], description: "第一个非空值" },
  { name: "UPPER", args: ["text"], description: "转为大写" }, { name: "LOWER", args: ["text"], description: "转为小写" },
  { name: "ROUND", args: ["value", "digits"], description: "四舍五入" },
];
const fn = (name: string, args: string[], description: string): FunctionInfo => ({ name, args, description });
const dialects: Partial<Record<SqlLanguage, FunctionInfo[]>> = {
  plsql: [fn("NVL", ["value", "fallback"], "空值替换"), fn("TO_CHAR", ["value", "format"], "转为字符"), fn("TO_DATE", ["text", "format"], "转为日期"), fn("DECODE", ["value", "match", "result", "fallback"], "条件映射")],
  mysql: [fn("IFNULL", ["value", "fallback"], "空值替换"), fn("DATE_FORMAT", ["date", "format"], "日期格式化"), fn("CONCAT", ["text1", "text2"], "拼接文本")],
  postgresql: [fn("STRING_AGG", ["text", "delimiter"], "聚合文本"), fn("DATE_TRUNC", ["precision", "timestamp"], "截取时间精度"), fn("TO_CHAR", ["value", "format"], "格式化数值或日期")],
  tsql: [fn("ISNULL", ["value", "fallback"], "空值替换"), fn("GETDATE", [], "当前日期时间"), fn("CONVERT", ["type", "value", "style"], "类型转换")],
  sqlite: [fn("IFNULL", ["value", "fallback"], "空值替换"), fn("STRFTIME", ["format", "time"], "日期格式化")],
  db2: [fn("VARCHAR_FORMAT", ["value", "format"], "日期或数字格式化")],
};
export const sqlAssistFunctions = (dialect: SqlLanguage) => [...common, ...(dialects[dialect === "mariadb" ? "mysql" : dialect] ?? [])];
export function sqlAssistKeywords(clause: SqlClause, dialect: SqlLanguage): string[] {
  if (["where", "on"].includes(clause)) return ["AND", "OR", "NOT", "IN", "EXISTS", "LIKE", "IS NULL", "IS NOT NULL", "BETWEEN"];
  if (["group", "order"].includes(clause)) return clause === "order" ? ["ASC", "DESC", ...(["plsql", "postgresql", "sqlite"].includes(dialect) ? ["NULLS FIRST", "NULLS LAST"] : [])] : ["HAVING"];
  if (clause === "set") return ["NULL", "DEFAULT"];
  return ["SELECT", "FROM", "JOIN", "LEFT JOIN", "INNER JOIN", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "UNION ALL", "INSERT INTO", "UPDATE", "DELETE FROM", "DISTINCT", "AS", "CASE", "WHEN", "THEN", "ELSE", "END", "NULL", ...(dialect === "plsql" ? ["SYSDATE", "ROWNUM"] : ["CURRENT_TIMESTAMP"])];
}
