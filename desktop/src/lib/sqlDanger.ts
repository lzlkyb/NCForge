/**
 * 危险语句识别：没有 WHERE 的 UPDATE / DELETE，以及不可逆的 DROP / TRUNCATE。
 *
 * 只做**静态**判断，不连库、不看数据。判据写在 tokens 的括号深度上，不是正则——
 * `update t set x=(select y from s where s.id=1)` 里那个 WHERE 属于子查询，
 * 用正则会把整表更新当成有条件的更新放过去，那正是最该拦的一类。
 *
 * 🔴 三条口径：
 * 1. **只有顶层 WHERE 算数**（括号深度 0）。子查询、`(select ...)` 里的 WHERE 一律不算。
 * 2. **`WHERE 1=1` 等同于没有 WHERE**。写脚本时常用它占位，但执行结果就是全表。
 * 3. **DROP / TRUNCATE 只提示不拦**（`advisory`）——删表的人通常是故意的，
 *    拦下来会变成纯粹的点确认训练；而 UPDATE/DELETE 漏写 WHERE 基本都是手滑。
 * 4. PL/SQL 块（`begin ... end;`）里藏着的 DML 不做静态判断：里面是过程式代码，
 *    猜错会误拦正常脚本。这条是已知边界，不改。
 */
import { scanSql, type SqlToken } from "./sqlLex";

export type DangerKind = "update-all" | "delete-all" | "drop" | "truncate";

export interface DangerFinding {
  kind: DangerKind;
  /** 语句动词，显示用。 */
  verb: string;
  /** 目标表的原样写法（可能带 schema 或别名）。 */
  table: string;
  /** `true` = 只提醒不拦截（DROP / TRUNCATE）。 */
  advisory: boolean;
  /** 数影响行数用的 COUNT 语句；advisory 或构造不出时为 undefined。 */
  countSql?: string;
}

const SKIP = new Set<SqlToken["kind"]>(["space", "comment", "hint"]);
const upper = (s: string) => s.toUpperCase();

/** 有效 token 及其括号深度（该 token 之前已经打开的括号数）。 */
function significant(sql: string): { token: SqlToken; depth: number; i: number }[] {
  const out: { token: SqlToken; depth: number; i: number }[] = [];
  let depth = 0;
  for (const token of scanSql(sql).tokens) {
    if (SKIP.has(token.kind)) continue;
    // `)` 先出层再记录：收尾括号与它的 `(` 同层，内部 token 才是深一层
    if (token.text === ")") depth = Math.max(0, depth - 1);
    out.push({ token, depth, i: out.length });
    if (token.text === "(") depth += 1;
  }
  return out;
}

/** 顶层（深度 0）第一个匹配 `word` 的下标。 */
function topLevel(list: ReturnType<typeof significant>, word: string, from = 0): number {
  for (let i = from; i < list.length; i++) if (list[i].depth === 0 && upper(list[i].token.text) === word) return i;
  return -1;
}

/** 表引用：标识符，可能是 `schema.table`，也可能是 `t` 或 `t 别名`。 */
function tableOf(sql: string, list: ReturnType<typeof significant>, from: number, end: number): string {
  return sql.slice(list[from].token.start, end).trim();
}

/** WHERE 之后到语句结尾（或 `RETURNING` / `INTO`）的文本，去掉末尾分号。用于拼 COUNT。 */
function whereTextOf(sql: string, list: ReturnType<typeof significant>, whereIdx: number, endPos: number): string {
  let end = endPos;
  for (let i = whereIdx + 1; i < list.length; i++) {
    if (list[i].depth === 0 && ["RETURNING", "INTO"].includes(upper(list[i].token.text))) { end = list[i].token.start; break; }
  }
  return sql.slice(list[whereIdx].token.start, end).trim().replace(/;\s*$/, "");
}

/** WHERE 之后的有效 token（注释/空白已被 `significant` 跳过），到 `RETURNING` / `INTO` 之前。 */
function whereTokens(list: ReturnType<typeof significant>, whereIdx: number): SqlToken[] {
  const out: SqlToken[] = [];
  for (let i = whereIdx + 1; i < list.length; i++) {
    if (list[i].depth === 0 && ["RETURNING", "INTO"].includes(upper(list[i].token.text))) break;
    out.push(list[i].token);
  }
  while (out.length > 0 && out[out.length - 1].text === ";") out.pop();
  return out;
}

/**
 * 只写了 `1=1` 的 WHERE —— 等于没有条件。
 *
 * 🔴 必须按 token 判，不能对文本跑正则：`delete from t where 1=1 -- 全表` 这种带尾注释的
 * 写法，正则匹配不上（`1=1` 后面还有注释），整表删除会被当成「有条件」放过去。
 * 括号在 token 里是同层级的，`(1=1)` 与 `1=1` 视为同一件事。
 */
function tautology(tokens: SqlToken[]): boolean {
  const inner = tokens.filter(t => t.text !== "(" && t.text !== ")");
  if (inner.length !== 3) return false;
  const one = (t: SqlToken) => t.text.replace(/^['"]|['"]$/g, "") === "1";
  return one(inner[0]) && inner[1].text === "=" && one(inner[2]);
}

/** WHERE 缺省、或者只有占位条件（`1=1`）⇒ 这条语句动整张表。 */
function allRows(list: ReturnType<typeof significant>, whereIdx: number): boolean {
  if (whereIdx < 0) return true;
  return tautology(whereTokens(list, whereIdx));
}

/**
 * COUNT 语句里的 WHERE 段。
 *
 * 占位条件（`1=1`）直接丢掉：它一行都筛不掉，留着会让「预估影响行数」多跑一次
 * 全表 COUNT —— 在几百万行的 NC 大表上就是双倍等待，而结果与不带 WHERE 完全一样。
 */
function countWhere(sql: string, list: ReturnType<typeof significant>, whereIdx: number, endPos: number): string {
  if (whereIdx < 0) return "";
  if (tautology(whereTokens(list, whereIdx))) return "";
  return ` ${whereTextOf(sql, list, whereIdx, endPos)}`;
}

/**
 * 检查一条语句。返回 null = 不危险（或识别不了，保守放过）。
 *
 * `dialect` 只影响词法（字符串/注释的边界），不影响判定。
 */
export function dangerOf(sql: string): DangerFinding | null {
  const list = significant(sql);
  if (list.length === 0) return null;
  const first = upper(list[0].token.text);
  const endPos = sql.length;

  if (first === "UPDATE") {
    // `update (select ...)` 可更新视图：认不出目标表就放过，不猜
    if (list[1]?.token.text === "(") return null;
    const setIdx = topLevel(list, "SET", 1);
    if (setIdx < 0) return null;
    const whereIdx = topLevel(list, "WHERE", setIdx + 1);
    if (!allRows(list, whereIdx)) return null;
    const ref = tableOf(sql, list, 1, list[setIdx].token.start);
    if (!ref) return null;
    return { kind: "update-all", verb: "UPDATE", table: ref, advisory: false, countSql: `select count(*) from ${ref}${countWhere(sql, list, whereIdx, endPos)}` };
  }

  if (first === "DELETE") {
    const fromIdx = topLevel(list, "FROM", 1);
    if (fromIdx < 0 || fromIdx + 1 >= list.length) return null;
    const whereIdx = topLevel(list, "WHERE", fromIdx + 1);
    if (!allRows(list, whereIdx)) return null;
    const ref = tableOf(sql, list, fromIdx + 1, whereIdx >= 0 ? list[whereIdx].token.start : endPos);
    if (!ref) return null;
    const table = ref.replace(/;\s*$/, "");
    return { kind: "delete-all", verb: "DELETE", table, advisory: false, countSql: `select count(*) from ${table}${countWhere(sql, list, whereIdx, endPos)}` };
  }

  if (first === "TRUNCATE" || first === "DROP") {
    // 只提醒不拦。`drop table t` / `drop view v` / `truncate table t` 都识别，
    // 对象类型词跳过，表名取它后面那一段。
    const OBJECT_WORDS = new Set(["TABLE", "VIEW", "INDEX", "SEQUENCE", "TRIGGER", "PROCEDURE", "FUNCTION", "PACKAGE", "TYPE"]);
    let at = 1;
    while (at < list.length && OBJECT_WORDS.has(upper(list[at].token.text))) at++;
    const ref = list[at] && list[at].depth === 0 ? tableOf(sql, list, at, endPos) : "";
    if (!ref) return null;
    return { kind: first === "DROP" ? "drop" : "truncate", verb: first, table: ref.replace(/;\s*$/, ""), advisory: true };
  }

  return null;
}

/** 批量检查；`texts` 是即将执行的语句文本（顺序即执行顺序）。 */
export function dangerousStatements(texts: readonly string[]): { index: number; sql: string; finding: DangerFinding }[] {
  const out: { index: number; sql: string; finding: DangerFinding }[] = [];
  texts.forEach((sql, index) => {
    const finding = dangerOf(sql);
    if (finding) out.push({ index, sql, finding });
  });
  return out;
}
