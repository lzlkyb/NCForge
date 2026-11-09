/**
 * 判断一条查询的结果能不能「按主键改回去」——SQL 控制台结果页双击编辑的前提。
 *
 * 口径故意保守：**只有最简单的单表 SELECT 才放行**。宁可不给编辑入口，也不能
 * 让用户在 JOIN 结果里改一格、然后把它当成那条记录改了。所有拒绝都带一句人话，
 * 界面直接显示这句话，用户知道为什么不能改。
 *
 * 为什么不用 SQL 解析器：这里要的只是「有没有把握定位到唯一一行」，正则足够且
 * 不会因为库里方言特性漏判；真正的定位靠主键列在结果里存在 + 写回时带原值守卫。
 */

const RULES: { re: RegExp; reason: string }[] = [
  { re: /\b(union|intersect|minus)\b/i, reason: "结果由多个查询合并，一行不对应一条记录" },
  { re: /\bgroup\s+by\b|\bhaving\b/i, reason: "结果按分组汇总，一行不对应一条记录" },
  { re: /\bdistinct\b/i, reason: "结果去重，一行可能来自多条记录" },
  { re: /\bover\s*\(/i, reason: "结果含窗口函数，一行不对应一条记录" },
  { re: /\b(connect\s+by|start\s+with)\b/i, reason: "结果来自层次查询" },
  { re: /\b(pivot|unpivot)\b/i, reason: "结果经过行列转换" },
  { re: /\bjoin\b/i, reason: "结果来自多表关联，改一行不知道改哪张表" },
  { re: /\bfrom\s*\(/i, reason: "结果来自子查询，定位不到唯一的基表" },
];

/** 聚合函数：一行是「一批记录算出来的」，改它没有对应记录。 */
const AGGREGATE = /\b(count|sum|avg|min|max|listagg|wm_concat|stddev|stddev_pop|stddev_samp|variance|var_pop|var_samp|median|ratio_to_report)\s*\(/i;

/** `schema.table` 或 `table`，与 `identifier()` 允许的字符集一致（带引号的对象名不支持）。 */
const TABLE_NAME = /^[a-zA-Z][\w$#]*(?:\.[a-zA-Z][\w$#]*)?$/;

function strip(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;+\s*$/, "");
}

export interface EditableSource {
  /** 可编辑时的基表名（可能是 `schema.table`）；不可编辑为 null。 */
  table: string | null;
  /** 不可编辑的原因，直接给用户看。可编辑时为空串。 */
  reason: string;
}

export function editableSource(sql: string): EditableSource {
  const core = strip(sql);
  if (!core) return { table: null, reason: "这条结果没有可解析的 SQL" };
  if (/;/.test(core)) return { table: null, reason: "只支持单条查询" };
  if (!/^select\b/i.test(core)) return { table: null, reason: "只有 SELECT 结果支持直接编辑" };
  // `with … select` 不认：CTE 里可能有多层来源，判断成本远高于收益。
  for (const rule of RULES) if (rule.re.test(core)) return { table: null, reason: rule.reason };
  if (AGGREGATE.test(core.split(/\bfrom\b/i)[0] ?? "")) return { table: null, reason: "结果列里有聚合计算" };
  const matched = core.match(/^select\s+[\s\S]+?\s+from\s+([^\s,()]+)/i);
  const table = matched?.[1]?.replace(/;$/, "") ?? "";
  if (!table) return { table: null, reason: "认不出这条查询的基表" };
  if (!TABLE_NAME.test(table)) return { table: null, reason: `基表名「${table}」不是普通表名，无法安全定位` };
  return { table, reason: "" };
}

/**
 * 结果里必须**带上全部主键列**才能改：缺一列就定位不到唯一行。
 * 返回主键列名（大写，与 `optimisticChanges` 的匹配口径一致）；不满足时给出原因。
 */
export function editableKeys(columns: { name: string }[], pk: string[]): { keys: string[]; reason: string } {
  if (!pk.length) return { keys: [], reason: "这张表没有主键，定位不到唯一行" };
  const names = new Set(columns.map(c => c.name.toUpperCase()));
  const missing = pk.filter(k => !names.has(k.toUpperCase()));
  if (missing.length) return { keys: [], reason: `结果里没有主键列 ${missing.join("、")}，定位不到唯一行` };
  return { keys: pk.map(k => k.toUpperCase()), reason: "" };
}

/**
 * 哪些列能在网格里直接改。
 *
 * 白名单而不是黑名单：写回要按类型绑定参数，遇到没见过的类型宁可不给编辑，
 * 也不要拼出一条在库里才会报错的 SQL。带时区的类型显式排除——会话时区一变，
 * 写回去的值就不是用户看到的那个了。
 */
export function editableCellType(type: string): boolean {
  if (/TIME ZONE/i.test(type)) return false;
  return /^(VARCHAR|NVARCHAR|CHAR|NCHAR|NUMBER|FLOAT|INTEGER|DECIMAL|DATE|TIMESTAMP|CLOB)/i.test(type);
}
