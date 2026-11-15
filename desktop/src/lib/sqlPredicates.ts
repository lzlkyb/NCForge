import type { SqlLanguage } from "sql-formatter";
import { snippetEscape } from "./sqlTemplates";

interface Predicate { operator: string; label: string; insertText: string; suffix: string; hint: string }

/** Literal shape follows the physical type, never a name such as dbilldate (often CHAR in NC). */
export function sqlPredicates(identifier: string, type: string, dialect: SqlLanguage, upper: boolean): Predicate[] {
  const t = type.trim().toUpperCase(), id = snippetEscape(identifier), kw = (s: string) => upper ? s : s.toLowerCase();
  const text = /^(?:N?VARCHAR2?|N?CHAR|CHARACTER|TEXT|CITEXT|UUID|U?ROWID)\b/.test(t);
  const number = /^(?:NUMBER|NUMERIC|DECIMAL|INTEGER|INT|SMALLINT|BIGINT|TINYINT|FLOAT|DOUBLE|REAL|BINARY_FLOAT|BINARY_DOUBLE|MONEY|SMALLMONEY|BIT)\b/.test(t);
  const temporal = /^(?:DATE|DATETIME2?|SMALLDATETIME|DATETIMEOFFSET|TIMESTAMP|TIMESTAMPTZ|TIME|TIMETZ)\b/.test(t) && !(dialect === "tsql" && /^TIMESTAMP\b/.test(t));
  const boolean = /^(?:BOOLEAN|BOOL)\b/.test(t);
  const date = t === "DATE", time = /^TIME(?:\b|\()/.test(t), zone = /\bWITH(?: LOCAL)? TIME ZONE\b|TIMESTAMPTZ|TIMETZ|DATETIMEOFFSET/.test(t);
  const hint = temporal ? date ? "填写 YYYY-MM-DD" : `填写日期时间${zone ? "及偏移量" : ""}` : number ? "直接填写数值" : text ? "在引号中填写文本" : "填写 SQL 值";
  const literal = (stop: string) => {
    if (!temporal) return text ? `'${stop}'` : stop;
    if (dialect === "sqlite") return `'${stop}'`;
    if (dialect === "tsql") return `${kw("CAST")}('${stop}' ${kw("AS")} ${date ? "date" : time ? "time" : zone ? "datetimeoffset" : "datetime2"})`;
    if (dialect === "mysql" || dialect === "mariadb") return `${kw("CAST")}('${stop}' ${kw("AS")} ${kw(date ? "DATE" : time ? "TIME" : "DATETIME")})`;
    if (dialect === "db2") return `${kw(date ? "DATE" : time ? "TIME" : "TIMESTAMP")}('${stop}')`;
    if (dialect === "plsql" && zone) return `${kw("TO_TIMESTAMP_TZ")}('${stop}', 'YYYY-MM-DD HH24:MI:SS TZH:TZM')`;
    return `${kw(date ? "DATE" : time ? "TIME" : "TIMESTAMP")}${zone ? kw(" WITH TIME ZONE") : ""} '${stop}'`;
  };
  const out: Predicate[] = [];
  const add = (operator: string, label: string, suffix: string) => out.push({ operator, label, suffix, insertText: `${id} ${suffix}`, hint });
  if (text || number || temporal || boolean) {
    add("=", "等于", `= ${literal("$0")}`);
    add("<>", "不等于", `<> ${literal("$0")}`);
    if (text) add("LIKE", "包含文本", `${kw("LIKE")} '%$0%'`);
    if (number || temporal) {
      for (const [op, label] of [[">", "大于"], [">=", "大于等于"], ["<", "小于"], ["<=", "小于等于"]]) add(op, label, `${op} ${literal("$0")}`);
      if (temporal) add("RANGE", "时间范围 · 含起点不含终点", `>= ${literal("${1}")} ${kw("AND")} ${id} < ${literal("${2}")}$0`);
      else add("BETWEEN", "范围 · 包含两端", `${kw("BETWEEN")} ${literal("${1}")} ${kw("AND")} ${literal("${2}")}$0`);
    }
    add("IN", "值列表", `${kw("IN")} (${literal("${1}")}, ${literal("${2}")})$0`);
  }
  add("IS NULL", "为空", `${kw("IS NULL")}$0`);
  add("IS NOT NULL", "不为空", `${kw("IS NOT NULL")}$0`);
  return out;
}
