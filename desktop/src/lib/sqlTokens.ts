/**
 * SQL 词法扫描：只为「结果能不能改回基表」服务，不做语法分析。
 *
 * 正则做不到的事恰好是这里最容易出错的：字符串字面量里的 `--`、`from`、`;`，
 * 注释里的 `join`，引号里的表名。先切词再按括号深度找顶层 `from`，
 * 选择列表/子查询里的关键字就不会再把基表认错。
 */

export type TokenKind = "word" | "quoted" | "string" | "number" | "punct";

export interface Token {
  kind: TokenKind;
  text: string;
  /** 括号深度：`(` 本身记进入前的深度，`)` 记退出后的深度。 */
  depth: number;
}

const WORD_START = /[A-Za-z_$#]/;
const WORD_PART = /[A-Za-z0-9_$#]/;

/** Oracle q'[…]' / nq'{…}'：任意分隔符，遇到「分隔符 + '」才结束。 */
function readQQuote(sql: string, at: number): { text: string; end: number } | null {
  const head = /^n?q'/i.exec(sql.slice(at, at + 4));
  if (!head) return null;
  const start = at + head[0].length;
  if (start >= sql.length) return { text: sql.slice(at), end: sql.length };
  const open = sql[start];
  const close = open === "[" ? "]" : open === "(" ? ")" : open === "{" ? "}" : open === "<" ? ">" : open;
  const end = sql.indexOf(close + "'", start + 1);
  return end < 0 ? { text: sql.slice(at), end: sql.length } : { text: sql.slice(at, end + 2), end: end + 2 };
}

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let depth = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    const q = readQQuote(sql, i);
    if (q) { out.push({ kind: "string", text: q.text, depth }); i = q.end; continue; }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      out.push({ kind: "string", text: sql.slice(i, j), depth });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j += 1; break; }
        j += 1;
      }
      out.push({ kind: "quoted", text: sql.slice(i, j), depth });
      i = j;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < sql.length && WORD_PART.test(sql[j])) j += 1;
      out.push({ kind: "word", text: sql.slice(i, j), depth });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j])) j += 1;
      out.push({ kind: "number", text: sql.slice(i, j), depth });
      i = j;
      continue;
    }
    if (c === "(") { out.push({ kind: "punct", text: c, depth }); depth += 1; i += 1; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); out.push({ kind: "punct", text: c, depth }); i += 1; continue; }
    out.push({ kind: "punct", text: c, depth });
    i += 1;
  }
  return out;
}

export const isWord = (token: Token | undefined, value: string): boolean =>
  !!token && token.kind === "word" && token.text.toUpperCase() === value;

/** 顶层（括号深度 0）的第一个指定关键字；`from` 默认从第 0 个找。 */
export function findTopWord(tokens: Token[], value: string, from = 0): number {
  for (let i = from; i < tokens.length; i += 1) {
    if (tokens[i].depth === 0 && isWord(tokens[i], value)) return i;
  }
  return -1;
}

/** 顶层是否出现某个关键字（可多个候选）。 */
export function hasTopWord(tokens: Token[], values: string[]): boolean {
  const set = new Set(values);
  return tokens.some(t => t.depth === 0 && t.kind === "word" && set.has(t.text.toUpperCase()));
}

/** 按顶层分隔符切段；分隔符本身不保留。 */
export function splitTop(tokens: Token[], separator = ","): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.depth === 0 && token.kind === "punct" && token.text === separator) {
      parts.push(current);
      current = [];
    } else current.push(token);
  }
  parts.push(current);
  return parts.filter(part => part.length > 0);
}

/** 与 `open` 处 `(` 配对的 `)` 下标。 */
export function matchingParen(tokens: Token[], open: number): number {
  const level = tokens[open]?.depth;
  for (let i = open + 1; i < tokens.length; i += 1) {
    if (tokens[i].kind === "punct" && tokens[i].text === ")" && tokens[i].depth === level) return i;
  }
  return -1;
}

/** 取一段子查询并把它内部的括号深度归零，便于独立分析。 */
export function normalizeDepth(tokens: Token[], from: number, to: number, base: number): Token[] {
  return tokens.slice(from, to).map(t => ({ ...t, depth: t.depth - base }));
}

/** 原样拼回一段 SQL（诊断面板/测试断言用；不保证空白格式）。 */
export function renderTokens(tokens: Token[]): string {
  return tokens.map(t => t.text).join(" ");
}
