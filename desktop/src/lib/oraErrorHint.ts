/**
 * 把 Oracle 的错误号翻译成「错在哪一处」。
 *
 * 只做**有确定线索**的那几种，其余原样保留——猜错位置比不指位置更糟：
 * 用户会盯着一个没错的地方改半天。
 *
 * 现在覆盖：
 * - `ORA-00904: "X": invalid identifier` —— 错误文本里带了标识符名，能直接在语句里定位。
 *   这是最高频的一类，而且往往是手滑写错列名/Alias。
 * - `ORA-01722` / `ORA-01438` / `ORA-12899` —— 文本里没有位置线索，只给一句解释。
 */

import { scanSql } from "./sqlLex";

export interface OraLocation {
  /** 出错的标识符原文（大小写按错误信息）。 */
  ident: string;
  /** 1-based 行号。 */
  line: number;
  /** 1-based 列号。 */
  column: number;
  /** 语句里出现的次数：>1 时提示「共 N 处」，别让用户以为定位到的就是唯一一处。 */
  occurrences: number;
}

export interface OraHint {
  code: string;
  /** 一句话解释 + 该往哪看。 */
  note?: string;
  location?: OraLocation;
}

/** 从错误文本里取 ORA 号（`ORA-00904`）。 */
export function oraCodeOf(error: string): string | null {
  return /ORA-(\d{5})/i.exec(error)?.[0].toUpperCase() ?? null;
}

/** `ORA-00904: "BD_XXX": invalid identifier` 里的那个标识符。 */
function identifierOf(error: string): string | null {
  const quoted = /ORA-00904:\s*"([^"]+)"/i.exec(error);
  if (quoted) return quoted[1].trim();
  const bare = /ORA-00904:\s*([A-Za-z][\w$#]*)\s*:/i.exec(error);
  return bare ? bare[1].trim() : null;
}

/**
 * 在语句里找这个标识符，返回第一处的位置与总出现次数。
 *
 * 🔴 必须走词法、不能直接跑正则：正则会在**字符串字面量与注释**里命中
 * （`select 'bd_xxx' from t where c = bd_xxx` 的第一处匹配是那个字符串），
 * 于是用户被指到一行没错的代码上去改。宁可少给位置，也不能给错位置。
 */
export function locateIdent(sql: string, ident: string): OraLocation | null {
  const want = ident.toUpperCase();
  const hits: number[] = [];
  for (const token of scanSql(sql).tokens) {
    if (token.kind === "string" || token.kind === "comment" || token.kind === "hint") continue;
    const name = token.kind === "quoted" ? token.text.slice(1, -1) : token.text;
    if (name.toUpperCase() === want) hits.push(token.start);
  }
  if (hits.length === 0) return null;
  const at = hits[0];
  const before = sql.slice(0, at);
  const line = before.split("\n").length;
  const column = at - before.lastIndexOf("\n");
  return { ident, line, column, occurrences: hits.length };
}

const NOTES: Record<string, string> = {
  "ORA-00904": "有一个标识符在这个上下文里不存在：列名写错、Alias 没声明，或者它属于另一张表。",
  "ORA-01722": "有值没法转成数字。常见是拿字符串列和数字比较、或 `''` 进了数字列。",
  "ORA-01438": "某个值超过了列的精度。检查数字列的长度和小数位。",
  "ORA-12899": "某个值超过了列的长度上限。",
  "ORA-01861": "日期字面量和格式对不上，用 `to_date('...','yyyy-mm-dd')` 明确格式。",
  "ORA-00947": "`insert` 的列数和 `values` 的值数不一致。",
  "ORA-00979": "`select` 里的列没有出现在 `group by` 里，也没有包聚合函数。",
};

/** 错误 + 语句 → 提示。没有可说的返回 null（调用方保留原始错误框）。 */
export function oraHint(error: string, sql: string): OraHint | null {
  const code = oraCodeOf(error);
  if (!code) return null;
  const note = NOTES[code];
  if (code === "ORA-00904") {
    const ident = identifierOf(error);
    const location = ident && sql ? locateIdent(sql, ident) ?? undefined : undefined;
    if (!note && !location) return null;
    return { code, note, location };
  }
  return note ? { code, note } : null;
}
