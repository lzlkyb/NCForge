import type { SqlLanguage } from "sql-formatter";
import { layoutTokens, type LayoutToken } from "./sqlLayoutTokens";

interface Row {
  text: string;
  originalIndent: number;
  indent: number;
  tokens: LayoutToken[];
  noJoin: boolean;
  locked: boolean;
  list?: number;
}

const words = (row: Row) => row.tokens.map(t => t.kind === "word" ? t.text.toUpperCase() : t.text).join(" ");
const firstWord = (row: Row) => row.tokens[0]?.kind === "word" ? row.tokens[0].text.toUpperCase() : "";
const listHeader = (row: Row) => /^(SELECT(?: DISTINCT| ALL)?|GROUP BY|ORDER BY)$/.test(words(row));
const shortHeader = (row: Row) => /^(FROM|WHERE|HAVING|LIMIT|OFFSET|FETCH FIRST)$/.test(words(row));
const isJoin = (row: Row) => /^(?:(?:LEFT|RIGHT|FULL|INNER|OUTER|CROSS|NATURAL) )*JOIN\b/.test(words(row));
const balanced = (row: Row) => {
  const first = row.tokens[0], last = row.tokens[row.tokens.length - 1];
  return first && last && first.depth + (first.text === ")" ? 1 : 0) === last.depth + (last.text === "(" ? 1 : 0);
};
const render = (row: Row) => row.locked ? row.text : " ".repeat(row.indent) + row.text;

function rowsOf(sql: string, tokens: LayoutToken[]): Row[] {
  const rows = sql.split("\n").map(text => {
    const indent = text.length - text.trimStart().length;
    return { text: text.trimStart(), originalIndent: indent, indent, tokens: [], noJoin: false, locked: false } as Row;
  });
  for (const token of tokens) {
    rows[token.line].tokens.push(token);
    if (token.kind === "comment" || token.line !== token.endLine) {
      for (let n = token.line; n <= token.endLine; n++) rows[n].noJoin = true;
    }
    // Never trim or reindent physical lines through a multiline string, identifier or comment.
    if (token.line !== token.endLine) {
      for (let n = token.line; n <= token.endLine; n++) rows[n].locked = true;
    }
  }
  const raw = sql.split("\n");
  rows.forEach((row, n) => { if (row.locked) row.text = raw[n]; });
  return rows;
}

function merge(left: Row, right: Row, width: number): boolean {
  if (!left.text || !right.text || left.noJoin || right.noJoin || left.indent + left.text.length + right.text.length + 1 > width) return false;
  left.text += " " + right.text;
  left.tokens.push(...right.tokens);
  return true;
}

function reduceFromIndent(rows: Row[], tab: number): void {
  const from: { indent: number; joining: boolean }[] = [];
  for (const row of rows) {
    if (!row.text) continue;
    while (from.length && row.originalIndent <= from[from.length - 1].indent) from.pop();
    row.indent = Math.max(0, row.originalIndent - from.length * tab);
    const owner = from[from.length - 1];
    if (owner && row.originalIndent === owner.indent + tab) {
      if (isJoin(row)) owner.joining = true;
      else if (owner.joining && !row.locked) row.indent += tab;
    }
    if (words(row) === "FROM") from.push({ indent: row.originalIndent, joining: false });
  }
}

/** The base formatter already supplies clause/element boundaries. Only join complete sibling elements. */
function fillRows(rows: Row[], width: number, tab: number): Row[] {
  const out: Row[] = [];
  const lists: { id: number; originalIndent: number }[] = [];
  for (const [id, row] of rows.entries()) {
    if (row.text) while (lists.length && row.originalIndent <= lists[lists.length - 1].originalIndent) lists.pop();
    const list = lists[lists.length - 1];
    const prev = out[out.length - 1];
    const item = list && row.originalIndent === list.originalIndent + tab && balanced(row)
      && !row.tokens.some(t => t.kind === "word" && ["CASE", "WHEN", "ELSE", "END", "SELECT", "WITH"].includes(t.text.toUpperCase()));
    if (item) {
      row.list = list.id;
      if (prev?.list === list.id && (listHeader(prev) || prev.tokens[prev.tokens.length - 1]?.text === ",") && merge(prev, row, width)) continue;
    } else if (prev && shortHeader(prev) && row.originalIndent === prev.originalIndent + tab && merge(prev, row, width)) continue;
    if (listHeader(row)) {
      row.list = id;
      lists.push({ id, originalIndent: row.originalIndent });
    }
    out.push(row);
  }
  return out;
}

function joinShortProjections(rows: Row[], width: number): Row[] {
  // A short projection and FROM can share one line, even when the query has longer WHERE conditions.
  const combined: Row[] = [];
  for (const row of rows) {
    const prev = combined[combined.length - 1];
    if (prev && !prev.locked && firstWord(prev) === "SELECT" && firstWord(row) === "FROM" && prev.indent === row.indent
      && prev.tokens.filter(t => t.text === "," && t.depth === prev.tokens[0].depth).length <= 1 && merge(prev, row, width)) continue;
    combined.push(row);
  }
  return combined;
}

function splitLongJoins(rows: Row[], width: number, tab: number): Row[] {
  const combined: Row[] = [];
  for (const row of rows) {
    // Put an oversized JOIN's ON at a safe clause boundary, without splitting its condition.
    if (isJoin(row) && !row.noJoin && row.indent + row.text.length > width) {
      const on = row.tokens.find(t => t.kind === "word" && t.text.toUpperCase() === "ON" && t.depth === row.tokens[0].depth);
      if (on) {
        const index = on.start - row.tokens[0].start;
        combined.push({ ...row, text: row.text.slice(0, index).trimEnd() });
        combined.push({ ...row, text: row.text.slice(index), indent: row.indent + tab });
        continue;
      }
    }
    combined.push(row);
  }
  return combined;
}

function groupPairs(tokens: LayoutToken[]): [number, number][] {
  const stack: number[] = [];
  const pairs: [number, number][] = [];
  tokens.forEach((t, i) => {
    if (t.kind !== "punct") return;
    if (t.text === "(") stack.push(i);
    if (t.text === ")") { const open = stack.pop(); if (open !== undefined) pairs.push([open, i]); }
  });
  return pairs;
}

function compactGroups(sql: string, language: SqlLanguage, width: number): string {
  const tokens = layoutTokens(sql, language);
  if (!tokens) return sql;
  const rows = rowsOf(sql, tokens);
  const removed = new Set<number>();
  // Inner pairs first, preserving nesting boundaries of every subquery and CASE expression.
  for (const [a, b] of groupPairs(tokens)) {
    const open = tokens[a], close = tokens[b];
    if (open.line === close.line || removed.has(open.line) || removed.has(close.line)) continue;
    const inside = tokens.slice(a + 1, b);
    if (inside.some(t => t.kind === "comment" || t.line !== t.endLine
      || (t.kind === "word" && ["SELECT", "WITH", "CASE", "UNION"].includes(t.text.toUpperCase())))) continue;
    if (rows[open.line].tokens[rows[open.line].tokens.length - 1] !== open || rows[close.line].tokens[0] !== close) continue;
    const live = rows.slice(open.line, close.line + 1).filter((_, i) => !removed.has(open.line + i));
    if (live.some(r => r.noJoin || !r.text)) continue;
    const content = live[0].text + live.slice(1, -1).map(r => r.text.trim()).join(" ") + live[live.length - 1].text.trim();
    if (rows[open.line].indent + content.length > width) continue;
    rows[open.line].text = content;
    for (let i = open.line + 1; i <= close.line; i++) removed.add(i);
  }
  return rows.filter((_, i) => !removed.has(i)).map(render).join("\n");
}

/** Deterministic reading layout with the expanded output as the safe fallback. */
export function readingLayout(expanded: string, language: SqlLanguage, width: number, tab: number): string {
  // Dialects with other literal forms keep their existing formatter until their protection is verified.
  if (!["sql", "plsql", "mysql", "mariadb", "postgresql", "tsql", "transactsql", "db2", "sqlite"].includes(language)) return expanded;
  const tokens = layoutTokens(expanded, language);
  if (!tokens) return expanded;
  if (tokens.some(t => t.kind === "comment" && /sql-formatter-(?:disable|enable)/i.test(t.text))) return expanded;
  const rows = rowsOf(expanded, tokens);
  reduceFromIndent(rows, tab);
  const compact = splitLongJoins(joinShortProjections(fillRows(rows, width, tab), width), width, tab).map(render).join("\n");
  const output = compactGroups(compact, language, width);
  const after = layoutTokens(output, language);
  // A layout optimization may only change whitespace outside tokens. Uncertain cases keep the base output.
  return after && tokens.length === after.length && tokens.every((t, i) => t.kind === after[i].kind && t.text === after[i].text) ? output : expanded;
}
