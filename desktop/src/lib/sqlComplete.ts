/**
 * SQL 补全的纯逻辑：别名解析、光标处该补什么。Monaco 的接线在 `sqlProviders.ts`。
 *
 * 别名只认 from / join / update / into 后面的「表名 [as] 别名」以及 from 里用逗号分隔的列表。
 * 子查询别名（`from (select …) x`）解析不到表，就不给字段——不乱推。
 */

const NOT_ALIAS = new Set([
  "where", "on", "join", "left", "right", "full", "inner", "outer", "cross", "set", "values", "group",
  "order", "having", "union", "minus", "intersect", "connect", "start", "using", "select", "partition",
  "natural", "for", "with",
]);

export const SQL_KEYWORDS = [
  "select", "from", "where", "and", "or", "not", "in", "exists", "like", "between", "is null", "is not null",
  "group by", "order by", "having", "distinct", "union all", "left join", "inner join", "on", "as", "case",
  "when", "then", "else", "end", "insert into", "values", "update", "set", "delete from", "commit", "rollback",
  "nvl", "decode", "to_char", "to_date", "substr", "instr", "trim", "count", "sum", "max", "min", "rownum",
  "sysdate", "dual",
];

/** 去掉字符串与注释（保持长度无所谓，只用于识别）。 */
function strip(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

const lastSeg = (name: string) => name.split(".").pop()!.toLowerCase();

/** 别名（小写）→ 表名（小写）。表名本身也映射到自己，`bd_material.code` 一样能补。 */
export function aliasMap(sql: string): Map<string, string> {
  const s = strip(sql);
  const map = new Map<string, string>();
  const add = (table: string, alias?: string) => {
    const t = lastSeg(table);
    map.set(t, t);
    if (alias && !NOT_ALIAS.has(alias.toLowerCase())) map.set(alias.toLowerCase(), t);
  };
  const head = /\b(from|join|update|into)\s+([a-z_][\w$#]*(?:\.[a-z_][\w$#]*)?)(?:\s+(?:as\s+)?([a-z_][\w$#]*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = head.exec(s)) !== null) {
    add(m[2], m[3]);
    if (m[1].toLowerCase() !== "from") continue;
    // from a x, b y, c
    const more = /\s*,\s*([a-z_][\w$#]*(?:\.[a-z_][\w$#]*)?)(?:\s+(?:as\s+)?([a-z_][\w$#]*))?/iy;
    more.lastIndex = head.lastIndex;
    let k: RegExpExecArray | null;
    while ((k = more.exec(s)) !== null) {
      add(k[1], k[2]);
      head.lastIndex = more.lastIndex;
    }
  }
  return map;
}

export type CompletionContext =
  | { kind: "column"; qualifier: string; prefix: string }
  | { kind: "table"; prefix: string }
  | { kind: "any"; prefix: string };

/** 光标前的文本 → 该补什么。 */
export function completionContext(before: string): CompletionContext {
  const q = /([A-Za-z_][\w$#]*)\.([\w$#]*)$/.exec(before);
  if (q) return { kind: "column", qualifier: q[1].toLowerCase(), prefix: q[2] };
  const prefix = /([\w$#]*)$/.exec(before)?.[1] ?? "";
  const head = before.slice(0, before.length - prefix.length);
  if (/\b(from|join|update|into|table)\s+$/i.test(strip(head)) || /\bfrom\s+[\w$#.]+(?:\s+\w+)?\s*,\s*$/i.test(strip(head))) {
    return { kind: "table", prefix };
  }
  return { kind: "any", prefix };
}

/** 语句里用到的表（去重，按出现顺序）——不带前缀的字段补全从这些表里取。 */
export function tablesIn(sql: string): string[] {
  return [...new Set(aliasMap(sql).values())];
}
