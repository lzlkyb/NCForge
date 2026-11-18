import type { SqlLanguage } from "sql-formatter";
import type { SqlClause } from "./sqlCompletionContext";

interface FunctionInfo {
  name: string;
  args: string[];
  description: string;
  /**
   * 合法且常见的位置。**只在无前缀时收窄**：用户敲了 to_ 就是在找函数，那时候
   * 全量给出、由前缀过滤；无前缀（Ctrl+空格）时全量 58 个会把字段和表名挤走，
   * 那时候只留当前子句真能用上的——SELECT 后面不给 WHERE 才成立的 DECODE 之类。
   */
  clauses: SqlClause[];
  /** 覆盖默认的 `NAME(arg, arg)` 片段（分析函数要带 OVER，环境函数要带引号字面量）。 */
  snippet?: string;
}

/** 标量函数：哪儿都能出现。 */
const WIDE: SqlClause[] = ["select", "where", "on", "insert", "group", "order"];
/** 聚合 / 窗口函数：只有投影里合法（WHERE 里要用 HAVING）。 */
const PROJECTED: SqlClause[] = ["select"];

const common: FunctionInfo[] = [
  { name: "COUNT", args: ["expression"], description: "统计行数或非空值", clauses: PROJECTED },
  { name: "SUM", args: ["expression"], description: "求和", clauses: PROJECTED },
  { name: "AVG", args: ["expression"], description: "平均值", clauses: PROJECTED },
  { name: "MAX", args: ["expression"], description: "最大值", clauses: WIDE },
  { name: "MIN", args: ["expression"], description: "最小值", clauses: WIDE },
  { name: "COALESCE", args: ["value", "fallback"], description: "第一个非空值", clauses: WIDE },
  { name: "UPPER", args: ["text"], description: "转为大写", clauses: WIDE },
  { name: "LOWER", args: ["text"], description: "转为小写", clauses: WIDE },
  { name: "ROUND", args: ["value", "digits"], description: "四舍五入（digits 可省；日期入参按格式舍入）", clauses: WIDE },
];

const fn = (name: string, args: string[], description: string, clauses: SqlClause[] = WIDE, snippet?: string): FunctionInfo => ({ name, args, description, clauses, snippet });

/** Oracle 常用函数。收张口径：NC 日常对账 / 查台账真会用的，不追求全覆盖。 */
const plsql: FunctionInfo[] = [
  // 聚合
  fn("LISTAGG", ["expression", "separator"], "组内拼接成字符串", PROJECTED, "LISTAGG(${1:expression}, ${2:', '}) WITHIN GROUP (ORDER BY ${3:column})"),
  fn("STDDEV", ["expression"], "标准差", PROJECTED),
  fn("VARIANCE", ["expression"], "方差", PROJECTED),
  // 字符
  fn("SUBSTR", ["text", "start", "length"], "取子串（start 从 1 起；length 可省）"),
  fn("INSTR", ["text", "substring", "start", "occurrence"], "查子串位置，找不到返回 0"),
  fn("LENGTH", ["text"], "字符数"),
  fn("TRIM", ["text"], "去掉首尾空格"),
  fn("LTRIM", ["text", "characters"], "去掉左端字符（characters 可省）"),
  fn("RTRIM", ["text", "characters"], "去掉右端字符（characters 可省）"),
  fn("REPLACE", ["text", "from", "to"], "替换子串"),
  fn("LPAD", ["text", "length", "pad"], "左端补齐到指定长度"),
  fn("RPAD", ["text", "length", "pad"], "右端补齐到指定长度"),
  // 正则
  fn("REGEXP_LIKE", ["text", "pattern", "match"], "正则匹配（match 可省：i 忽略大小写等）"),
  fn("REGEXP_SUBSTR", ["text", "pattern", "position", "occurrence"], "正则取子串"),
  fn("REGEXP_REPLACE", ["text", "pattern", "replacement"], "正则替换"),
  fn("REGEXP_INSTR", ["text", "pattern", "position"], "正则查位置"),
  fn("REGEXP_COUNT", ["text", "pattern"], "正则匹配次数"),
  // 数值
  fn("TRUNC", ["value", "digits"], "截断：日期到单位、数值到小数位（digits 可省）"),
  fn("MOD", ["a", "b"], "取余"),
  fn("CEIL", ["n"], "向上取整"),
  fn("FLOOR", ["n"], "向下取整"),
  fn("SIGN", ["n"], "符号：正 1 / 零 0 / 负 -1"),
  fn("POWER", ["a", "b"], "a 的 b 次方"),
  fn("SQRT", ["n"], "平方根"),
  fn("ABS", ["n"], "绝对值"),
  fn("GREATEST", ["a", "b"], "取较大值（可多参）"),
  fn("LEAST", ["a", "b"], "取较小值（可多参）"),
  // 日期
  fn("SYSDATE", [], "当前日期时间（会话时区）", ["select", "where", "on", "insert"]),
  fn("CURRENT_DATE", [], "当前日期（会话时区）", ["select", "where", "on", "insert"]),
  fn("CURRENT_TIMESTAMP", [], "当前时间戳（带时区）", ["select", "where", "on", "insert"]),
  fn("ADD_MONTHS", ["date", "months"], "日期加月份（months 可为负）"),
  fn("MONTHS_BETWEEN", ["date1", "date2"], "两个日期相差几个月"),
  fn("LAST_DAY", ["date"], "当月最后一天"),
  fn("NEXT_DAY", ["date", "weekday"], "下一个星期几（如 'MONDAY'）"),
  fn("EXTRACT", ["field", "date"], "取日期分量：YEAR / MONTH / DAY / HOUR…", WIDE, "EXTRACT(${1:YEAR} FROM ${2:date})"),
  fn("TO_DATE", ["text", "format"], "文本转日期（格式可省，按 NLS 口径）", ["select", "where", "on", "insert"]),
  fn("TO_TIMESTAMP", ["text", "format"], "文本转时间戳", ["select", "where", "on", "insert"]),
  fn("TO_NUMBER", ["text", "format"], "文本转数值", ["select", "where", "on", "insert"]),
  // 条件 / 空值
  fn("NVL2", ["value", "ifNotNull", "ifNull"], "非空取前者，为空取后者"),
  fn("NULLIF", ["a", "b"], "相等返回空，否则返回 a"),
  fn("DECODE", ["value", "match", "result", "fallback"], "条件映射，等价于 CASE 简写"),
  // 分析（窗口）
  fn("ROW_NUMBER", [], "行号，需配 OVER 子句", PROJECTED, "ROW_NUMBER() OVER (ORDER BY ${1:column})"),
  fn("RANK", [], "排名（并列后跳号），需配 OVER 子句", PROJECTED, "RANK() OVER (ORDER BY ${1:column})"),
  fn("DENSE_RANK", [], "排名（并列不跳号），需配 OVER 子句", PROJECTED, "DENSE_RANK() OVER (ORDER BY ${1:column})"),
  fn("LAG", ["expression", "offset", "default"], "取前 N 行值，需配 OVER 子句", PROJECTED, "LAG(${1:expression}) OVER (ORDER BY ${2:column})"),
  fn("LEAD", ["expression", "offset", "default"], "取后 N 行值，需配 OVER 子句", PROJECTED, "LEAD(${1:expression}) OVER (ORDER BY ${2:column})"),
  fn("FIRST_VALUE", ["expression"], "窗口内首个值", PROJECTED, "FIRST_VALUE(${1:expression}) OVER (ORDER BY ${2:column})"),
  fn("LAST_VALUE", ["expression"], "窗口内末个值", PROJECTED, "LAST_VALUE(${1:expression}) OVER (ORDER BY ${2:column})"),
  // 环境
  fn("USER", [], "当前登录用户", ["select", "where", "on", "insert"]),
  fn("USERENV", ["option"], "会话属性：LANG / TERMINAL / ISDBA / INSTANCE…", ["select", "where", "on"], "USERENV('${1:LANG}')"),
  fn("SYS_CONTEXT", ["namespace", "attribute"], "取上下文属性，如 USERENV 命名空间", ["select", "where", "on"], "SYS_CONTEXT('${1:USERENV}', '${2:LANG}')"),
];

const dialects: Partial<Record<SqlLanguage, FunctionInfo[]>> = {
  plsql,
  mysql: [
    fn("IFNULL", ["value", "fallback"], "空值替换"),
    fn("DATE_FORMAT", ["date", "format"], "日期格式化"),
    fn("CONCAT", ["text1", "text2"], "拼接文本"),
  ],
  postgresql: [
    fn("STRING_AGG", ["text", "delimiter"], "聚合文本", PROJECTED),
    fn("DATE_TRUNC", ["precision", "timestamp"], "截取时间精度"),
    fn("TO_CHAR", ["value", "format"], "格式化数值或日期"),
  ],
  tsql: [
    fn("ISNULL", ["value", "fallback"], "空值替换"),
    fn("GETDATE", [], "当前日期时间", ["select", "where", "on", "insert"]),
    fn("CONVERT", ["type", "value"], "类型转换"),
  ],
  sqlite: [
    fn("IFNULL", ["value", "fallback"], "空值替换"),
    fn("STRFTIME", ["format", "time"], "日期格式化"),
  ],
  db2: [fn("VARCHAR_FORMAT", ["value", "format"], "日期或数字格式化")],
};

export const sqlAssistFunctions = (dialect: SqlLanguage): FunctionInfo[] => [...common, ...(dialects[dialect === "mariadb" ? "mysql" : dialect] ?? [])];

/**
 * 无前缀（Ctrl+空格）时只给当前子句真能用上的；有前缀 = 用户在找函数，全量交前缀过滤。
 * 其余调用方一律用 `sqlAssistFunctions` 拿全量。
 */
export const sqlAssistFunctionsFor = (dialect: SqlLanguage, clause: SqlClause, hasPrefix: boolean): FunctionInfo[] =>
  hasPrefix ? sqlAssistFunctions(dialect) : sqlAssistFunctions(dialect).filter(f => f.clauses.includes(clause));

export function sqlAssistKeywords(clause: SqlClause, dialect: SqlLanguage): string[] {
  if (["where", "on"].includes(clause)) return ["AND", "OR", "NOT", "IN", "EXISTS", "LIKE", "IS NULL", "IS NOT NULL", "BETWEEN"];
  if (["group", "order"].includes(clause)) return clause === "order" ? ["ASC", "DESC", ...(["plsql", "postgresql", "sqlite"].includes(dialect) ? ["NULLS FIRST", "NULLS LAST"] : [])] : ["HAVING"];
  if (clause === "set") return ["NULL", "DEFAULT"];
  return ["SELECT", "FROM", "JOIN", "LEFT JOIN", "INNER JOIN", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "UNION ALL", "INSERT INTO", "UPDATE", "DELETE FROM", "DISTINCT", "AS", "CASE", "WHEN", "THEN", "ELSE", "END", "NULL", ...(dialect === "plsql" ? ["SYSDATE", "ROWNUM"] : ["CURRENT_TIMESTAMP"])];
}
