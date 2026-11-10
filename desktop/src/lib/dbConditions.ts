import type { BoundCell, ColumnInfo } from "./dbApi";

export type Operator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "between" | "null" | "notnull" | "today" | "last7days";
export interface Condition { column: string; op: Operator; value: string; end: string }
export interface TableFilter { conditions: Condition[]; join: "and" | "or"; sort: string; descending: boolean }
export const emptyFilter = (): TableFilter => ({ conditions: [], join: "and", sort: "", descending: false });
export function identifier(value: string): string {
  if (!/^[a-zA-Z][\w$#]*(?:\.[a-zA-Z][\w$#]*)?$/.test(value)) throw new Error(`不支持的对象名称：${value}`);
  return value;
}
export function compileFilter(filter: TableFilter, columns: ColumnInfo[]): { where: string; order: string; params: BoundCell[] } {
  const params: BoundCell[] = [];
  const bind = (value: string, col: ColumnInfo) => {
    const numeric = /^(NUMBER|INTEGER|FLOAT|DECIMAL|DOUBLE)/i.test(col.type);
    if (numeric && (!value.trim() || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) throw new Error(`${col.name} 需要有效数字`);
    if (/^(DATE|TIMESTAMP)/i.test(col.type)) {
      if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(value)) throw new Error(`${col.name} 需要日期或时间`);
      params.push(value.length === 10 ? `${value}T00:00:00` : value.length === 16 ? `${value}:00` : value);
      return `to_timestamp(:${params.length}, 'YYYY-MM-DD"T"HH24:MI:SS')`;
    }
    params.push(numeric ? {number:value.trim()} : value);
    return `:${params.length}`;
  };
  const parts = filter.conditions.map(c => {
    const col = columns.find(v => v.name === c.column);
    if (!col) throw new Error("请选择现有字段");
    const name = identifier(col.name);
    if (c.op === "null" || c.op === "notnull") return `${name} is ${c.op === "notnull" ? "not " : ""}null`;
    if (c.op === "today" || c.op === "last7days") {
      if (!/^(DATE|TIMESTAMP)/i.test(col.type)) throw new Error("日期快捷范围仅适用于日期字段");
      const start = new Date(); start.setHours(0,0,0,0);
      if (c.op === "last7days") start.setDate(start.getDate()-6);
      // 次日排他上限避免遗漏带小数秒的记录；整个日期范围仍是一个条件，OR组合不会拆散它。
      const end = new Date(); end.setHours(0,0,0,0); end.setDate(end.getDate()+1);
      const date = (v:Date) => `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,"0")}-${String(v.getDate()).padStart(2,"0")}`;
      return `${name} >= ${bind(date(start),col)} and ${name} < ${bind(date(end),col)}`;
    }
    if (c.op === "in") {
      const values = c.value.split(",").map(value=>value.trim());
      if (values.length > 1000 || values.some(value=>!value)) throw new Error("IN 需要1到1000个非空值，用逗号分隔；值中含逗号时请使用手写条件");
      return `${name} in (${values.map(value=>bind(value,col)).join(", ")})`;
    }
    if (c.op === "contains") {
      if (/^(NUMBER|INTEGER|FLOAT|DECIMAL|DOUBLE|DATE|TIMESTAMP)/i.test(col.type)) throw new Error("包含条件仅适用于文本字段");
      params.push(`%${c.value.replace(/[\\%_]/g, "\\$&")}%`);
      return `${name} like :${params.length} escape '\\'`;
    }
    const start = bind(c.value, col);
    if (c.op === "between") return `${name} between ${start} and ${bind(c.end, col)}`;
    const operators = {eq:"=",ne:"<>",gt:">",gte:">=",lt:"<",lte:"<="};
    if (!Object.prototype.hasOwnProperty.call(operators,c.op)) throw new Error("不支持的筛选运算符");
    return `${name} ${operators[c.op as keyof typeof operators]} ${start}`;
  });
  if (filter.sort && !columns.some(c => c.name === filter.sort)) throw new Error("排序字段不存在");
  return { where: parts.map(s => `(${s})`).join(` ${filter.join} `), order: filter.sort ? `${identifier(filter.sort)} ${filter.descending ? "desc" : "asc"}` : "", params };
}
const key = (connId: string, table: string) => `ncforge-db-filter:${encodeURIComponent(connId)}:${table.toLowerCase()}`;
export function loadFilter(connId: string, table: string): TableFilter {
  try {
    const v = JSON.parse(localStorage.getItem(key(connId, table)) ?? "null");
    if (v && Array.isArray(v.conditions) && v.conditions.length <= 100 && v.conditions.every((c: Condition) => c && typeof c.column === "string" && ["eq","ne","gt","gte","lt","lte","in","contains","between","null","notnull","today","last7days"].includes(c.op) && typeof c.value === "string" && typeof c.end === "string") && ["and", "or"].includes(v.join) && typeof v.sort === "string" && typeof v.descending === "boolean") return v;
  } catch { /* 本机偏好不可用时保留默认查询。 */ }
  return emptyFilter();
}
export function saveFilter(connId: string, table: string, filter: TableFilter): void {
  localStorage.setItem(key(connId, table), JSON.stringify(filter));
}
