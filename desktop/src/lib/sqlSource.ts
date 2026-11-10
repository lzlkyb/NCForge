/**
 * 从 SELECT 里认出「这一行来自哪张表、哪一列」，以及哪一列写回去没有对应表列。
 *
 * 与旧版正则最大的差别：
 * - 先过词法器，字符串/注释里的关键字不再参与判断；
 * - 只认**括号深度 0** 的 `from`，选择列表里的标量子查询不会把基表认成子查询里的表；
 * - 逗号连接、`(+)` 旧式外连接、表函数、dblink 全部拒绝——这些结果改一行可能改错表；
 * - 显式列做「输出列名 → 表列名」映射，`code as 编码` 写回的是 `CODE`，不是 `编码`；
 * - 简单 CTE（`with x as (select * from 单表) select * from x`）按 CTE 的基表放行。
 *
 * 判定仍然保守：JOIN 结果不猜写哪张表，交给「手动指定基表/定位列」。
 */
import { findTopWord, hasTopWord, isWord, matchingParen, normalizeDepth, splitTop, tokenize, type Token } from "./sqlTokens";

export type SourceCode =
  | "ok" | "no-sql" | "not-select" | "multi" | "union" | "group" | "distinct" | "window"
  | "hierarchical" | "pivot" | "join" | "subquery" | "aggregate" | "no-table" | "table-name"
  | "dblink" | "table-function" | "recursive-cte" | "cte";

export interface QueryColumnMap {
  /** 输出列名（大写）→ 表列名；`null` = 表达式/重命名后对不上表列。 */
  output: string;
  source: string | null;
}

export interface QuerySource {
  /** 可编辑时的基表名（可能带 schema）；不可编辑为 null。 */
  table: string | null;
  alias: string | null;
  /** 选择列表含 `*` / `t.*`：未显式列出的结果列按同名表列处理。 */
  star: boolean;
  /** 输出列名（大写）→ 表列名；null 表示这一列不能写回。 */
  mapping: Map<string, string | null>;
  /** 结果里显式选了 `rowid`（或 CTE 带出 rowid）。 */
  rowid: boolean;
  reason: string;
  code: SourceCode;
  /** 给诊断面板看的一句话：认出了什么。 */
  detail: string;
}

const TABLE_NAME = /^[a-zA-Z][\w$#]*(?:\.[a-zA-Z][\w$#]*)?$/;
const AGGREGATE = new Set([
  "COUNT", "SUM", "AVG", "MIN", "MAX", "LISTAGG", "WM_CONCAT", "STDDEV", "STDDEV_POP",
  "STDDEV_SAMP", "VARIANCE", "VAR_POP", "VAR_SAMP", "MEDIAN", "RATIO_TO_REPORT",
]);
const ALIAS_STOP = new Set([
  "WHERE", "GROUP", "HAVING", "ORDER", "CONNECT", "START", "MODEL", "FETCH", "FOR",
  "OFFSET", "SAMPLE", "PARTITION", "PIVOT", "UNPIVOT", "ONLY", "WITH",
]);
const FROM_STOP = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "CONNECT", "START", "MODEL", "FETCH", "FOR", "OFFSET"]);
const JOIN_WORDS = new Set(["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL"]);

function blocked(code: SourceCode, reason: string): QuerySource {
  return { table: null, alias: null, star: false, mapping: new Map(), rowid: false, reason, code, detail: "" };
}

function unquote(text: string): string {
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).replace(/""/g, '"') : text;
}

/** 取选择项末尾的别名；`a + b` / `a || b` 里的 b 不是别名。 */
function stripAlias(tokens: Token[]): { body: Token[]; alias: string | null } {
  const n = tokens.length;
  if (n < 2) return { body: tokens, alias: null };
  const last = tokens[n - 1];
  if (isWord(tokens[n - 2], "AS") && (last.kind === "word" || last.kind === "quoted")) {
    return { body: tokens.slice(0, n - 2), alias: unquote(last.text).toUpperCase() };
  }
  if (last.kind !== "word" && last.kind !== "quoted") return { body: tokens, alias: null };
  // `t.code` 是限定列名，不是「t 的别名 code」；`a.b c` 才是别名。
  const qualified = n === 3 && tokens[0].kind === "word" && tokens[1].text === ".";
  if (qualified) return { body: tokens, alias: null };
  const prev = tokens[n - 2];
  const endsValue = prev.kind === "word" || prev.kind === "quoted" || prev.kind === "number" || prev.text === ")";
  return endsValue ? { body: tokens.slice(0, n - 1), alias: unquote(last.text).toUpperCase() } : { body: tokens, alias: null };
}

interface SelectItem { star: boolean; rowid: boolean; output: string | null; source: string | null }

function parseSelectItem(tokens: Token[]): SelectItem {
  const { body, alias } = stripAlias(tokens);
  const simpleStar = (body.length === 1 && body[0].text === "*")
    || (body.length === 3 && body[0].kind === "word" && body[1].text === "." && body[2].text === "*");
  if (simpleStar) return { star: true, rowid: false, output: null, source: null };
  const simpleCol = body[0]?.kind === "word" && (body.length === 1
    || (body.length === 3 && body[1].text === "." && body[2].kind === "word"));
  const name = simpleCol ? (body.length === 1 ? body[0].text : body[2].text) : null;
  if (name && name.toUpperCase() === "ROWID") {
    return { star: false, rowid: true, output: null, source: null };
  }
  return {
    star: false,
    rowid: false,
    output: (alias ?? name)?.toUpperCase() ?? null,
    source: name,
  };
}

function parseSelectList(tokens: Token[]) {
  const items = splitTop(tokens).map(parseSelectItem);
  return {
    star: items.some(i => i.star),
    rowid: items.some(i => i.rowid),
    items,
  };
}

function hasTopAggregate(tokens: Token[]): boolean {
  return tokens.some((t, i) => t.depth === 0 && t.kind === "word" && AGGREGATE.has(t.text.toUpperCase())
    && tokens[i + 1]?.text === "(" && tokens[i + 1]?.depth === 0);
}

function hasTopPair(tokens: Token[], first: string, second: string): boolean {
  return tokens.some((t, i) => t.depth === 0 && isWord(t, first)
    && isWord(tokens[i + 1], second) && tokens[i + 1].depth === 0);
}

function parseFrom(tokens: Token[]): { ok: true; table: string; alias: string | null } | { ok: false; code: SourceCode; reason: string } {
  if (tokens.some(t => t.text === "@")) return { ok: false, code: "dblink", reason: "表名带数据库链接（@），无法确认写回的是本地表" };
  if (tokens.some(t => t.kind === "word" && t.depth === 0 && JOIN_WORDS.has(t.text.toUpperCase()))) {
    return { ok: false, code: "join", reason: "结果来自多表关联，改一行不知道改哪张表" };
  }
  if (splitTop(tokens).length > 1) return { ok: false, code: "join", reason: "FROM 后有多个表（逗号连接），改一行不知道改哪张表" };
  if (tokens[0]?.text === "(") return { ok: false, code: "subquery", reason: "结果来自子查询，定位不到唯一的基表" };
  if (isWord(tokens[0], "TABLE") && tokens[1]?.text === "(") return { ok: false, code: "table-function", reason: "结果来自表函数，定位不到唯一的基表" };
  if (tokens[0]?.kind !== "word") return { ok: false, code: "table-name", reason: "认不出这条查询的基表" };
  let at = 1;
  let table = tokens[0].text;
  if (tokens[1]?.text === ".") {
    if (tokens[2]?.kind !== "word") return { ok: false, code: "table-name", reason: "基表名带引号或特殊字符，无法安全定位" };
    table = `${table}.${tokens[2].text}`;
    at = 3;
  }
  if (!TABLE_NAME.test(table)) {
    return { ok: false, code: "table-name", reason: `基表名「${table}」不是普通表名，无法安全定位` };
  }
  // 表名后面允许别名，其余写法（表函数、分区、SAMPLE）都不猜。
  if (tokens[at]?.text === "(" || (tokens[at]?.kind === "word" && ["PARTITION", "SUBPARTITION", "SAMPLE"].includes(tokens[at].text.toUpperCase()))) {
    return { ok: false, code: "table-function", reason: "基表后面跟了不支持的写法（表函数 / 分区 / SAMPLE）" };
  }
  let alias: string | null = null;
  if (isWord(tokens[at], "AS") && (tokens[at + 1]?.kind === "word" || tokens[at + 1]?.kind === "quoted")) {
    alias = unquote(tokens[at + 1].text);
  } else if ((tokens[at]?.kind === "word" || tokens[at]?.kind === "quoted")
    && !(tokens[at]?.kind === "word" && ALIAS_STOP.has(tokens[at].text.toUpperCase()))) {
    alias = unquote(tokens[at].text);
  }
  const consumed = !alias ? at : isWord(tokens[at], "AS") ? at + 2 : at + 1;
  if (consumed < tokens.length) {
    return { ok: false, code: "table-name", reason: "基表后有无法识别的写法，无法安全定位" };
  }
  return { ok: true, table, alias };
}

function parseWith(tokens: Token[]): { ok: true; ctes: Map<string, Token[]>; body: Token[] } | { ok: false; code: SourceCode; reason: string } {
  const ctes = new Map<string, Token[]>();
  let i = 1;
  if (isWord(tokens[i], "RECURSIVE")) return { ok: false, code: "recursive-cte", reason: "递归 CTE 的一行不对应固定的一条记录，不能在网格里改" };
  while (i < tokens.length) {
    const name = tokens[i];
    if (name.kind !== "word") return { ok: false, code: "cte", reason: "认不出 CTE 名称，无法安全定位基表" };
    i += 1;
    if (tokens[i]?.text === "(") {
      const close = matchingParen(tokens, i);
      if (close < 0) return { ok: false, code: "cte", reason: "CTE 定义不完整" };
      return { ok: false, code: "cte", reason: "CTE 列重命名暂不支持；请直接用原列名，或把查询展开成单表 SELECT" };
    }
    if (!isWord(tokens[i], "AS") || tokens[i + 1]?.text !== "(") return { ok: false, code: "cte", reason: "CTE 定义不完整" };
    const open = i + 1;
    const close = matchingParen(tokens, open);
    if (close < 0) return { ok: false, code: "cte", reason: "CTE 定义不完整" };
    ctes.set(name.text.toLowerCase(), normalizeDepth(tokens, open + 1, close, tokens[open].depth + 1));
    i = close + 1;
    if (tokens[i]?.text === ",") { i += 1; continue; }
    break;
  }
  return { ok: true, ctes, body: tokens.slice(i) };
}

function analyzeSelect(tokens: Token[], ctes: Map<string, Token[]>, seen: Set<string>): QuerySource {
  if (!tokens.length || !isWord(tokens[0], "SELECT")) {
    return blocked("not-select", "只有 SELECT 结果支持直接编辑");
  }
  if (hasTopWord(tokens, ["UNION", "INTERSECT", "MINUS"])) {
    return blocked("union", "结果由多个查询合并，一行不对应一条记录");
  }
  if (hasTopWord(tokens, ["DISTINCT"])) return blocked("distinct", "结果去重，一行可能来自多条记录");
  if (hasTopWord(tokens, ["PIVOT", "UNPIVOT"])) return blocked("pivot", "结果经过行列转换");
  if (hasTopWord(tokens, ["HAVING"]) || hasTopPair(tokens, "GROUP", "BY")) {
    return blocked("group", "结果按分组汇总，一行不对应一条记录");
  }
  if (hasTopPair(tokens, "CONNECT", "BY") || hasTopPair(tokens, "START", "WITH")) {
    return blocked("hierarchical", "结果来自层次查询");
  }
  const windowed = tokens.some((t, i) => t.depth === 0 && isWord(t, "OVER") && tokens[i + 1]?.text === "(");
  if (windowed) return blocked("window", "结果含窗口函数，一行不对应一条记录");

  const from = findTopWord(tokens, "FROM");
  if (from < 0) return blocked("no-table", "这条查询没有 FROM 子句，结果不对应任何表");
  // 旧式外连接标记在 WHERE 里，`from` 子句本身看不出来。
  if (tokens.some((t, i) => t.depth === 0 && t.text === "(" && tokens[i + 1]?.text === "+" && tokens[i + 2]?.text === ")")) {
    return blocked("join", "结果来自旧式外连接（(+)），改一行不知道改哪张表");
  }
  const selectTokens = tokens.slice(1, from);
  if (hasTopAggregate(selectTokens)) return blocked("aggregate", "结果列里有聚合计算，一行是一批记录算出来的");

  let stop = tokens.length;
  for (let i = from + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.depth === 0 && token.kind === "word" && FROM_STOP.has(token.text.toUpperCase())) { stop = i; break; }
  }
  const fromTokens = tokens.slice(from + 1, stop);
  const source = parseFrom(fromTokens);
  if (!source.ok) return blocked(source.code, source.reason);

  const parsed = parseSelectList(selectTokens);
  let table = source.table;
  let alias = source.alias;
  let star = parsed.star;
  let rowid = parsed.rowid;
  const mapping = new Map<string, string | null>();

  const cte = !source.table.includes(".") ? ctes.get(source.table.toLowerCase()) : undefined;
  if (cte && !seen.has(source.table.toLowerCase())) {
    const nextSeen = new Set(seen).add(source.table.toLowerCase());
    const inner = analyzeSelect(cte, ctes, nextSeen);
    if (!inner.table) return blocked(inner.code, `CTE ${source.table}：${inner.reason}`);
    table = inner.table;
    alias = inner.alias;
    star = parsed.star ? inner.star : false;
    rowid = parsed.rowid ? inner.rowid : (parsed.star && inner.rowid);
    for (const item of parsed.items) {
      if (!item.output) continue;
      if (!item.source) { mapping.set(item.output, null); continue; }
      const key = item.source.toUpperCase();
      mapping.set(item.output, inner.star ? (inner.mapping.has(key) ? inner.mapping.get(key)! : item.source) : (inner.mapping.get(key) ?? null));
    }
    if (!parsed.star) for (const [key, value] of inner.mapping) if (!mapping.has(key)) mapping.set(key, value);
  } else {
    for (const item of parsed.items) {
      if (item.output) mapping.set(item.output, item.source);
    }
  }

  const detail = [
    `基表 ${table}${alias ? `（别名 ${alias}）` : ""}`,
    star ? "选择列表含 *" : "",
    rowid ? "结果带 rowid" : "",
    cte ? `经 CTE ${source.table}` : "",
  ].filter(Boolean).join("；");
  return { table, alias, star, mapping, rowid, reason: "", code: "ok", detail };
}

export function analyzeSql(sql: string): QuerySource {
  let tokens = tokenize(sql);
  if (!tokens.length) return blocked("no-sql", "这条结果没有可解析的 SQL");
  const semis = tokens.filter(t => t.depth === 0 && t.text === ";");
  if (semis.length > 1 || (semis.length === 1 && tokens[tokens.length - 1].text !== ";")) {
    return blocked("multi", "只支持单条查询");
  }
  if (semis.length) tokens = tokens.slice(0, -1);
  if (!tokens.length) return blocked("no-sql", "这条结果没有可解析的 SQL");
  if (isWord(tokens[0], "WITH")) {
    const withClause = parseWith(tokens);
    if (!withClause.ok) return blocked(withClause.code, withClause.reason);
    if (!isWord(withClause.body[0], "SELECT")) return blocked("not-select", "只有 SELECT 结果支持直接编辑");
    return analyzeSelect(withClause.body, withClause.ctes, new Set());
  }
  return analyzeSelect(tokens, new Map(), new Set());
}
