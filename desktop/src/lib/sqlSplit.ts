/**
 * SQL 脚本切分：按 `;` 与单独一行的 `/` 切成语句，并给出每条在原文里的位置。
 *
 * 规则（与 SQL*Plus / PL/SQL Developer 的习惯一致）：
 * - 字符串（`'…'`、`"…"`）与注释（`--`、块注释）里的分号不算；
 * - PL/SQL 块（begin / declare / create [or replace] procedure|function|package|trigger|type）
 *   里面到处是分号，只认单独一行的 `/` 结束（或到文末）；
 * - 普通语句遇到 `;` 或单独一行的 `/` 结束。
 *
 * 返回的 `text` 已去掉结尾的 `;` / `/`（PL/SQL 块保留 `end;` 的分号），可以直接交给 JDBC。
 */

export interface Stmt {
  text: string;
  /** 在原文里的起止偏移（`end` 不含），包含结尾的分号。 */
  start: number;
  end: number;
  /** 起止行号（从 1 开始）。 */
  startLine: number;
  endLine: number;
}

const PLSQL_HEAD = /^(begin|declare|create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type))\b/i;

/** 去掉开头的空白与注释后的文本（只用于判断语句类别）。 */
export function stripLeading(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith("--")) {
      const nl = t.indexOf("\n");
      s = nl < 0 ? "" : t.slice(nl + 1);
    } else if (t.startsWith("/*")) {
      const e = t.indexOf("*/");
      s = e < 0 ? "" : t.slice(e + 2);
    } else {
      return t;
    }
  }
}

export function isPlsql(sql: string): boolean {
  return PLSQL_HEAD.test(stripLeading(sql));
}

export type StmtKind = "query" | "dml" | "ddl" | "plsql" | "other";

export function stmtKind(sql: string): StmtKind {
  const s = stripLeading(sql).toLowerCase();
  if (isPlsql(s) || /^call\b/.test(s)) return "plsql";
  const first = /^[a-z]+/.exec(s)?.[0] ?? "";
  if (first === "select" || first === "with" || first === "explain") return "query";
  if (["insert", "update", "delete", "merge", "lock"].includes(first)) return "dml";
  if (["create", "alter", "drop", "truncate", "grant", "revoke", "rename", "comment", "purge", "flashback"].includes(first)) return "ddl";
  return "other";
}

/** 会改数据或结构的语句（生产库执行前要确认）。 */
export function isWrite(sql: string): boolean {
  return stmtKind(sql) !== "query";
}

/**
 * 单调前进的行号计数器：查询的偏移量必须不减，整篇只扫一遍。
 * 原来每条语句都从文首数换行，几千条语句的脚本是 O(语句数 × 长度)。
 */
function lineCounter(text: string): (offset: number) => number {
  let pos = 0;
  let line = 1;
  return (offset) => {
    const to = Math.min(offset, text.length);
    for (; pos < to; pos++) if (text.charCodeAt(pos) === 10) line++;
    return line;
  };
}

/** 是否只有空白与注释。 */
function isBlank(s: string): boolean {
  return stripLeading(s).trim() === "";
}

/** 行首（只隔着空白）且这一行只有一个 `/`。 */
function isSlashLine(text: string, i: number): number | null {
  const lineStart = text.lastIndexOf("\n", i - 1) + 1;
  if (text.slice(lineStart, i).trim() !== "") return null;
  const nl = text.indexOf("\n", i);
  const lineEnd = nl < 0 ? text.length : nl;
  return text.slice(i + 1, lineEnd).trim() === "" ? lineEnd : null;
}

const WORD_CHAR = /[A-Za-z0-9_$#]/;

/**
 * `'` 前面是不是 q 引号的开头（`q'…'` / `nq'…'`）。
 *
 * 只认「q 是独立词」：标识符里末尾的 q（`seq'…'`）不是 q 引号。
 * 为什么必须单独处理：q 引号的内容里允许出现 `'` 和 `;`
 * （`q'[it's fine; really]'`），按普通字符串扫会在 `it's` 的引号处提前结束，
 * 后面的分号就被当成语句结束了。
 */
function isQQuoteStart(text: string, i: number): boolean {
  const q = text[i - 1];
  if (q !== "q" && q !== "Q") return false;
  let p = i - 2;
  if (p >= 0 && (text[p] === "n" || text[p] === "N")) p -= 1;
  return p < 0 || !WORD_CHAR.test(text[p]);
}

/** q 引号的结束位置（开引号 `'` 的下标为 `i`）；找不到返回 null。 */
function qQuoteEnd(text: string, i: number): number | null {
  const open = text[i + 1];
  if (open === undefined) return null;
  const pairs: Record<string, string> = { "[": "]", "{": "}", "(": ")", "<": ">" };
  const close = pairs[open] ?? open;
  const at = text.indexOf(`${close}'`, i + 2);
  return at < 0 ? null : at + 2;
}

export function splitStatements(text: string): Stmt[] {
  const out: Stmt[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  // 当前语句是否 PL/SQL 块：看到第一个有效字符后才知道
  let plsql: boolean | null = null;
  // push 按偏移递增调用（本条起点 ≤ 本条终点 < 下一条起点），可以共用一个计数器
  const lineAt = lineCounter(text);

  const push = (endExclusive: number, bodyEnd: number) => {
    const raw = text.slice(start, bodyEnd);
    if (!isBlank(raw.replace(/;\s*$/, ""))) {
      // 起点跳过前导空白（注释保留：它常是这条语句的说明）
      let s = start;
      while (s < bodyEnd && /\s/.test(text[s])) s++;
      let body = text.slice(s, bodyEnd);
      if (!plsql) body = body.replace(/;\s*$/, "");
      body = body.replace(/\s+$/, "");
      out.push({
        text: body,
        start: s,
        end: endExclusive,
        startLine: lineAt(s),
        endLine: lineAt(Math.max(s, endExclusive - 1)),
      });
    }
    start = endExclusive;
    plsql = null;
  };

  while (i < n) {
    const c = text[i];
    if (c === "/") {
      const lineEnd = isSlashLine(text, i);
      if (lineEnd !== null) {
        push(lineEnd, i);
        i = lineEnd;
        continue;
      }
    }
    if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (plsql === null && !/\s/.test(c)) {
      plsql = isPlsql(text.slice(start, Math.min(n, i + 120)));
    }
    if (c === "'" && isQQuoteStart(text, i)) {
      i = qQuoteEnd(text, i) ?? n;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === c) {
          if (text[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === ";" && !plsql) {
      push(i + 1, i + 1);
      i++;
      continue;
    }
    i++;
  }
  push(n, n);
  return out;
}

/**
 * 光标所在的语句（`Ctrl+Enter` 只执行它）。
 *
 * 光标落在两条语句之间的空白里时取上方最近的一条（刚敲完分号、回车后的习惯动作）；
 * 上方没有就取第一条。
 */
export function statementAt(text: string, offset: number): Stmt | null {
  return pickStatement(splitStatements(text), offset);
}

/**
 * 在已切好的语句里找光标所在的一条（规则同 `statementAt`），二分查找。
 * 编辑器缓存了切分结果，光标移动只走这里，不再重切整篇。
 */
export function pickStatement(all: readonly Stmt[], offset: number): Stmt | null {
  if (all.length === 0) return null;
  // 最后一条 start <= offset 的语句
  let lo = 0;
  let hi = all.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].start <= offset) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx < 0) return all[0];
  // 光标正好落在上一条的结尾 = 下一条的开头时，按原规则取上一条
  if (idx > 0 && all[idx - 1].end >= offset) return all[idx - 1];
  // 命中就是它；没命中说明在它之后的空白里，同样取它（上方最近的一条）
  return all[idx];
}
