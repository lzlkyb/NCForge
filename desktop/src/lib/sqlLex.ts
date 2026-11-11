import type { SqlLanguage } from "sql-formatter";

/** Compare SQL references after the engine's identifier folding, retaining quoted case. */
export function sqlReferenceKey(name: string, reference: string | undefined, dialect: SqlLanguage = "sql"): string {
  if (["mysql", "mariadb", "sqlite", "tsql"].includes(dialect)) return name.toLowerCase();
  if (reference && /^["`[]/.test(reference)) return name;
  return dialect === "postgresql" ? name.toLowerCase() : name.toUpperCase();
}

export type SqlTokenKind = "space" | "identifier" | "quoted" | "keyword" | "type" | "number" | "string" | "comment" | "hint" | "parameter" | "operator";
export interface SqlToken { start: number; end: number; text: string; kind: SqlTokenKind }
export interface SqlLexState { mode: "plain" | "quote" | "block"; end: string; kind: SqlTokenKind; depth: number; escape: boolean }
export const initialSqlState = (): SqlLexState => ({ mode: "plain", end: "", kind: "string", depth: 0, escape: false });
const words = (text: string) => new Set(text.split(" "));
const KEYWORDS = words("select from where and or not in exists like between is null group by order having distinct all union intersect except minus join left right full inner outer cross natural on using as case when then else end insert into values update set delete merge matched create alter drop table view index sequence trigger procedure function package body begin declare return returns commit rollback with recursive over partition rows range preceding following current row asc desc nulls first last for of fetch next only offset limit truncate grant revoke primary foreign key references constraint unique default check enable disable replace temporary database schema if loop while exception execute call lateral materialized cast interval date timestamp boolean true false");
const ORACLE = words("connect start prior nocycle siblings rownum level sysdate systimestamp dual returning bulk collect forall connect_by_root connect_by_isleaf connect_by_iscycle pivot unpivot model sample rowid urowid row_number");
const TYPES = words("varchar char nchar nvarchar text number numeric decimal integer int smallint bigint float double real binary varbinary date timestamp interval boolean blob clob raw long xml money bit serial json jsonb uuid");
const ORACLE_TYPES = words("varchar2 nvarchar2 binary_float binary_double nclob pls_integer binary_integer rowtype type");
const identifierStart = /[\p{L}_]/u, identifierPart = /[\p{L}\p{N}_$#]/u;
export function sqlWordKind(text: string, dialect: SqlLanguage): SqlTokenKind {
  const lower = text.toLowerCase();
  if (TYPES.has(lower) || (dialect === "plsql" && ORACLE_TYPES.has(lower))) return "type";
  return KEYWORDS.has(lower) || (dialect === "plsql" && ORACLE.has(lower)) ? "keyword" : "identifier";
}

/** Tolerant scanner: unfinished SQL keeps its string/comment state instead of inventing keywords. */
export function scanSql(text: string, dialect: SqlLanguage = "sql", previous = initialSqlState()): { tokens: SqlToken[]; state: SqlLexState } {
  const state = { ...previous }, tokens: SqlToken[] = [];
  let i = 0;
  const emit = (start: number, kind: SqlTokenKind) => tokens.push({ start, end: i, text: text.slice(start, i), kind });
  while (i < text.length) {
    const start = i;
    if (state.mode !== "plain") { i = consumeState(text, i, state, dialect); emit(start, state.kind); continue; }
    if (/\s/.test(text[i])) { while (i < text.length && /\s/.test(text[i])) i++; emit(start, "space"); continue; }
    if (text.startsWith("--", i) || ((dialect === "mysql" || dialect === "mariadb") && text[i] === "#")) {
      i = text.indexOf("\n", i); if (i < 0) i = text.length; emit(start, text.startsWith("--+", start) ? "hint" : "comment"); continue;
    }
    if (text.startsWith("/*", i)) {
      Object.assign(state, { mode: "block", depth: 1, kind: text[i + 2] === "+" ? "hint" : "comment" });
      i = consumeState(text, i + 2, state, dialect); emit(start, state.kind); continue;
    }
    const quote = quoteAt(text, i, dialect);
    if (quote) {
      Object.assign(state, { mode: "quote", end: quote.end, kind: quote.kind, escape: quote.escape });
      i = consumeState(text, i + quote.length, state, dialect); emit(start, quote.kind); continue;
    }
    const parameter = parameterAt(text.slice(i), dialect);
    if (parameter) { i += parameter.length; emit(start, "parameter"); continue; }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(i));
    if (number) { i += number[0].length; emit(start, "number"); continue; }
    if (identifierStart.test(text[i])) {
      i++; while (i < text.length && identifierPart.test(text[i])) i++; emit(start, sqlWordKind(text.slice(start, i), dialect)); continue;
    }
    i += /^(?:::|:=|<=|>=|<>|!=|\|\||->>|->)/.exec(text.slice(i))?.[0].length ?? 1;
    emit(start, "operator");
  }
  return { tokens, state };
}

function consumeState(text: string, at: number, state: SqlLexState, dialect: SqlLanguage): number {
  let i = at;
  while (i < text.length) {
    if (state.mode === "block") {
      if (text.startsWith("/*", i) && (dialect === "postgresql" || dialect === "tsql")) { state.depth++; i += 2; }
      else if (text.startsWith("*/", i)) { i += 2; if (--state.depth === 0) { state.mode = "plain"; break; } }
      else i++;
    } else if (state.escape && text[i] === "\\") i += Math.min(2, text.length - i);
    else if (text.startsWith(state.end, i)) {
      i += state.end.length;
      if (state.end.length === 1 && text.startsWith(state.end, i)) i++;
      else { state.mode = "plain"; break; }
    } else i++;
  }
  return i;
}

function quoteAt(text: string, at: number, dialect: SqlLanguage) {
  const rest = text.slice(at);
  if (dialect === "plsql") {
    const q = /^(?:nq|q)'([^\s])/i.exec(rest);
    if (q) return { length: q[0].length, end: (({ "[": "]", "(": ")", "{": "}", "<": ">" } as Record<string, string>)[q[1]] ?? q[1]) + "'", kind: "string" as const, escape: false };
  }
  if (dialect === "postgresql") {
    const dollar = /^\$(?:[a-z_]\w*)?\$/i.exec(rest);
    if (dollar) return { length: dollar[0].length, end: dollar[0], kind: "string" as const, escape: false };
  }
  const literal = /^(?:n|e)?'/i.exec(rest);
  if (literal) return { length: literal[0].length, end: "'", kind: "string" as const, escape: dialect === "mysql" || dialect === "mariadb" || (dialect === "postgresql" && /^e/i.test(rest)) };
  const delimiter = text[at];
  if (delimiter === '"' || ((dialect === "mysql" || dialect === "mariadb") && delimiter === "`") || ((dialect === "tsql" || dialect === "sqlite") && delimiter === "[")) {
    return { length: 1, end: delimiter === "[" ? "]" : delimiter, kind: delimiter === '"' && (dialect === "mysql" || dialect === "mariadb") ? "string" as const : "quoted" as const, escape: dialect === "mysql" || dialect === "mariadb" };
  }
  return null;
}

function parameterAt(rest: string, dialect: SqlLanguage): string | undefined {
  if (rest[0] === "?" && dialect !== "postgresql") return "?";
  if (rest[0] === ":" && rest[1] !== ":" && rest[1] !== "=") return /^:(?:[\p{L}_][\p{L}\p{N}_$#]*|\d+)/u.exec(rest)?.[0];
  if (dialect === "postgresql") return /^\$\d+/.exec(rest)?.[0];
  if (dialect === "tsql") return /^@@?[\w#]+/.exec(rest)?.[0];
  return undefined;
}

export const isSqlName = (token?: SqlToken): token is SqlToken & { kind: "identifier" | "quoted" } => !!token && (token.kind === "identifier" || token.kind === "quoted");
export function sqlName(token: SqlToken): string {
  if (token.kind !== "quoted") return token.text.toLowerCase();
  const end = token.text[token.text.length - 1];
  return token.text.slice(1, -1).split(end + end).join(end);
}
