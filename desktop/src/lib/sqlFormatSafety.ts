import type { FormatOptions, SqlLanguage } from "sql-formatter";
import { scanSql, type SqlToken } from "./sqlLex";

interface TextRange { start: number; end: number }

export class SqlFormatSafetyError extends Error {}

function lineOf(sql: string, offset: number): TextRange {
  const lineEnd = sql.indexOf("\n", offset);
  return { start: offset === 0 ? 0 : sql.lastIndexOf("\n", offset - 1) + 1, end: lineEnd < 0 ? sql.length : lineEnd + 1 };
}

/** Offsets arrive in document order. Whitespace boundaries may safely be trimmed. */
export function cutsSqlToken(tokens: readonly SqlToken[], offsets: readonly number[]) {
  let index = 0;
  for (const offset of offsets) {
    while (index < tokens.length && tokens[index].end <= offset) index++;
    const token = tokens[index];
    if (token && token.kind !== "space" && token.start < offset && offset < token.end) return true;
  }
  return false;
}

export function partialSqlFormatProblem(sql: string, start: number, end: number, dialect: SqlLanguage): string | null {
  if (mysqlDelimiterRegions(sql, dialect).some(region => region.start < end && region.end > start)) {
    return "选区涉及 DELIMITER 指令或过程体，已保留原文";
  }
  return cutsSqlToken(scanSql(sql, dialect).tokens, [start, end]) ? "选区截断了 SQL 标记，已保留原文" : null;
}

export function preserveSqlFormatEdges(input: string, formatted: string): string {
  const body = input.trim();
  if (!body) return input;
  const from = input.indexOf(body);
  return input.slice(0, from) + formatted + input.slice(from + body.length);
}

/** DELIMITER changes the client's statement boundaries. Leave its entire region byte-for-byte. */
export function mysqlDelimiterRegions(sql: string, dialect: SqlLanguage): TextRange[] {
  if (!["mysql", "mariadb", "tidb", "singlestoredb"].includes(dialect) || !/^\s*DELIMITER[\t ]+/im.test(sql)) return [];
  const regions: TextRange[] = [];
  let start: number | undefined;
  for (const token of scanSql(sql, dialect).tokens) {
    if (token.text.toUpperCase() !== "DELIMITER") continue;
    const line = lineOf(sql, token.start);
    if (!/^[\t \r]*$/.test(sql.slice(line.start, token.start))) continue;
    const argument = /^[\t ]+("[^"]*"|'[^']*'|`[^`]*`|\S+)(?:[\t ]+(?:--[\t ]|#)[^\r\n]*)?[\t \r\n]*$/.exec(sql.slice(token.end, line.end));
    if (!argument) continue;
    start ??= line.start;
    if ([";", "';'", '";"', "`;`"].includes(argument[1])) {
      regions.push({ start, end: line.end });
      start = undefined;
    }
  }
  if (start !== undefined) regions.push({ start, end: sql.length });
  return regions;
}

const significant = (tokens: readonly SqlToken[]) => tokens.filter(token => token.kind !== "space");
const expectedCase = (text: string, mode?: string) => mode === "upper" ? text.toUpperCase() : mode === "lower" ? text.toLowerCase() : text;

function isClientLine(sql: string, token: SqlToken, dialect: SqlLanguage) {
  if (token.text === "/" && dialect === "plsql") {
    const line = lineOf(sql, token.start);
    return sql.slice(line.start, line.end).trim() === "/";
  }
  if (token.text.toUpperCase() === "GO" && (dialect === "tsql" || dialect === "transactsql")) {
    const line = lineOf(sql, token.start);
    return /^GO(?:[\t ]+[0-9]+)?(?:[\t ]*--[^\n]*)?$/i.test(sql.slice(line.start, line.end).trim());
  }
  return false;
}

/** Validate against the user's input before allowing changes from either formatter layer. */
export function assertSqlFormatPreserves(
  input: string, original: ReturnType<typeof scanSql>, output: string, dialect: SqlLanguage, options: Partial<FormatOptions>,
) {
  if (output === input) return;
  const scanned = scanSql(output, dialect);
  const before = significant(original.tokens), after = significant(scanned.tokens);
  const valid = original.state.mode === scanned.state.mode && before.length === after.length && before.every((token, i) => {
    const next = after[i];
    if (token.kind !== next.kind || isClientLine(input, token, dialect) !== isClientLine(output, next, dialect)) return false;
    if (dialect === "postgresql" && token.kind === "string" && before[i - 1]?.kind === "string") {
      // Adjacent PostgreSQL strings concatenate only across a newline.
      if (input.slice(before[i - 1].end, token.start).includes("\n") !== output.slice(after[i - 1].end, next.start).includes("\n")) return false;
    }
    if (token.text === next.text) return true;
    if (token.kind === "keyword") return next.text === expectedCase(token.text, options.keywordCase);
    if (token.kind === "type") return next.text === expectedCase(token.text, options.dataTypeCase);
    if (token.kind === "identifier") return next.text === expectedCase(token.text, options.identifierCase);
    return token.kind === "comment" && token.text.trimEnd() === next.text.trimEnd();
  });
  if (!valid) throw new SqlFormatSafetyError("排版结果改变了原 SQL 的词法或脚本边界，已保留原文");
}
