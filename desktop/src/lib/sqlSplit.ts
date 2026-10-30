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

function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
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

export function splitStatements(text: string): Stmt[] {
  const out: Stmt[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  // 当前语句是否 PL/SQL 块：看到第一个有效字符后才知道
  let plsql: boolean | null = null;

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
        startLine: lineAt(text, s),
        endLine: lineAt(text, Math.max(s, endExclusive - 1)),
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
  const all = splitStatements(text);
  if (all.length === 0) return null;
  const hit = all.find((s) => offset >= s.start && offset <= s.end);
  if (hit) return hit;
  const before = all.filter((s) => s.end <= offset);
  return before.length ? before[before.length - 1] : all[0];
}
