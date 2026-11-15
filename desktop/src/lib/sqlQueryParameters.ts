import { scanSql } from "./sqlLex";
import { splitStatements, stmtKind } from "./sqlSplit";
import type { BoundCell } from "./dbApi";

const tokens = (sql: string) => scanSql(sql, "plsql").tokens;
const named = (sql: string) => tokens(sql).filter(t => t.kind === "parameter" && /^:[\p{L}_]/u.test(t.text));
const key = (text: string) => text.slice(1).toLowerCase();

export function queryParameters(sql: string): string[] {
  return [...new Set(named(sql).map(t => key(t.text)))];
}

export function canParameterizeQuery(sql: string): boolean {
  const statements = splitStatements(sql);
  const significant = tokens(sql).filter(t => !["space", "comment", "hint"].includes(t.kind));
  return statements.length === 1 && stmtKind(statements[0].text) === "query" &&
    ["SELECT", "WITH"].includes(significant[0]?.text.toUpperCase()) &&
    significant.every(t => t.kind !== "parameter" || /^:[\p{L}_]/u.test(t.text));
}

export function parameterizeLiteral(sql: string, start: number, end: number, name: string): string | null {
  if (!canParameterizeQuery(sql) || !/^[a-z_][a-z0-9_]*$/i.test(name)) return null;
  const literal = tokens(sql).find(t => t.start === start && t.end === end);
  if (literal?.kind !== "string" && literal?.kind !== "number") return null;
  return sql.slice(0, start) + ":" + name + sql.slice(end);
}

export function bindQuery(sql: string, values: ReadonlyMap<string, BoundCell>) {
  let end = 0;
  const params: BoundCell[] = [];
  let statement = "";
  for (const token of named(sql)) {
    if (!values.has(key(token.text))) throw new Error("查询参数缺少值");
    params.push(values.get(key(token.text))!);
    statement += sql.slice(end, token.start) + ":" + params.length;
    end = token.end;
  }
  return { sql: statement + sql.slice(end), params };
}
