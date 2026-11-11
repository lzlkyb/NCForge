import type { SqlLanguage } from "sql-formatter";

/** Layout only needs token boundaries, not a second SQL grammar. Offsets protect literal payloads. */
export interface LayoutToken {
  text: string;
  kind: "word" | "literal" | "comment" | "punct";
  start: number;
  line: number;
  endLine: number;
  depth: number;
}

function quotedEnd(sql: string, at: number, close: string, escapes: boolean): number {
  at++;
  while (at < sql.length) {
    if (escapes && sql[at] === "\\") { at += 2; continue; }
    if (sql[at] === close) {
      if (sql[at + 1] === close) { at += 2; continue; }
      return at + 1;
    }
    at++;
  }
  return -1;
}

function literalEnd(sql: string, at: number, language: SqlLanguage, mysql: boolean): number | null {
  const q = /^n?q'/i.exec(sql.slice(at, at + 4));
  const dollar = language === "postgresql" && /^\$(?:[A-Za-z_][\w]*|)\$/.exec(sql.slice(at));
  if (q) {
    const open = sql[at + q[0].length];
    const close = ({ "[": "]", "(": ")", "{": "}", "<": ">" } as Record<string, string>)[open] ?? open;
    const end = sql.indexOf(close + "'", at + q[0].length + 1);
    return end < 0 ? -1 : end + 2;
  }
  if (dollar) {
    const end = sql.indexOf(dollar[0], at + dollar[0].length);
    return end < 0 ? -1 : end + dollar[0].length;
  }
  const c = sql[at];
  if (!["'", '"', "`", "["].includes(c)) return null;
  const escapes = mysql || (language === "postgresql" && c === "'" && /\bE$/i.test(sql.slice(Math.max(0, at - 2), at)));
  return quotedEnd(sql, at, c === "[" ? "]" : c, escapes);
}

function commentEnd(sql: string, at: number, nested: boolean): number {
  let nesting = 1;
  at += 2;
  while (at < sql.length && nesting) {
    if (sql.startsWith("*/", at)) { nesting--; at += 2; }
    else if (nested && sql.startsWith("/*", at)) { nesting++; at += 2; }
    else at++;
  }
  return nesting ? -1 : at;
}

/** Refuse uncertain lexical boundaries so the caller can preserve the base formatter's output. */
export function layoutTokens(sql: string, language: SqlLanguage): LayoutToken[] | null {
  const tokens: LayoutToken[] = [];
  const mysql = ["mysql", "mariadb", "tidb", "singlestoredb"].includes(language);
  const nestedComments = ["postgresql", "tsql", "transactsql"].includes(language);
  let at = 0, line = 0, depth = 0;
  while (at < sql.length) {
    if (/\s/.test(sql[at])) { if (sql[at] === "\n") line++; at++; continue; }
    const start = at, firstLine = line;
    let kind: LayoutToken["kind"] = "punct";
    const c = sql[at];
    if (sql.startsWith("--", at) || (mysql && c === "#")) {
      kind = "comment";
      const end = sql.indexOf("\n", at);
      at = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", at)) {
      kind = "comment";
      at = commentEnd(sql, at, nestedComments);
      if (at < 0) return null;
    } else {
      const end = literalEnd(sql, at, language, mysql);
      if (end !== null) {
        if (end < 0) return null;
        kind = "literal";
        at = end;
      } else if (/[\p{L}\p{N}_$#]/u.test(c)) {
        kind = "word";
        at++;
        while (at < sql.length && /[\p{L}\p{N}_$#]/u.test(sql[at])) at++;
      } else at++;
    }
    const text = sql.slice(start, at);
    line += text.split("\n").length - 1;
    if (kind === "punct" && c === ")") { depth--; if (depth < 0) return null; }
    tokens.push({ text, kind, start, line: firstLine, endLine: line, depth });
    if (kind === "punct" && c === "(") depth++;
  }
  return depth === 0 ? tokens : null;
}
