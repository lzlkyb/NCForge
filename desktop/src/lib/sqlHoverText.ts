/**
 * SQL 悬停卡片的文案（纯函数，可单测）。
 *
 * 三条口径：
 * 1. **只写事实，不写建议**。悬停是「看一眼就走」的动作，多一句话就多一次打断。
 * 2. **查不到就说查不到**。结构没加载时明说「结构还没加载」，不要空着卡片让用户
 *    以为是「这张表没有字段」。
 * 3. 字段的中文名来自 NC 元数据（`md_column.displayname`），不是 NC 表就没有——
 *    这时整行不渲染，不写「暂无中文名」这种占位。
 */
import type { ColumnInfo } from "./dbApi";

export interface TableFacts {
  /** 库里的表名原样。 */
  name: string;
  /** NC 中文名（`md_table.displayname`）。 */
  zh?: string | null;
  /** `TABLE` / `VIEW`。 */
  kind?: string | null;
  /** 已知的字段数；结构没加载时不传。 */
  columns?: number;
  /** 结构是否加载过：false 时明确写「尚未加载」，避免被读成「没有字段」。 */
  loaded: boolean;
}

/** 表名悬停。`Ctrl+点击` 的入口本来就有（LinkProvider），这里只提醒一句。 */
export function tableHover(f: TableFacts): string {
  const head = `**${f.name}**${f.zh ? ` · ${f.zh}` : ""}`;
  const lines = [head];
  const meta: string[] = [];
  if (f.kind) meta.push(f.kind === "VIEW" ? "视图" : "表");
  if (typeof f.columns === "number") meta.push(`${f.columns} 个字段`);
  if (meta.length) lines.push(meta.join(" · "));
  // 🔴 不能写成 `else if`：`kind` 几乎总有值，那样这句话永远不会显示，
  // 用户会把「结构没缓存」读成「这张表没有字段」。
  if (!f.loaded) lines.push("结构还没加载，刷新连接后可以看到字段数");
  lines.push("`Ctrl+点击` 打开 DDL");
  return lines.join("\n\n");
}

/** 字段悬停：类型、中文名、主键/可空、注释、所属表。 */
export function columnHover(c: ColumnInfo, table?: string): string {
  const lines = [`**${c.name}** \`${c.full || c.type}\`${c.zh ? ` · ${c.zh}` : ""}`];
  const flags: string[] = [];
  if (c.pk) flags.push("主键");
  flags.push(c.nullable ? "可为空" : "不可空");
  if (c.default) flags.push(`默认 ${c.default}`);
  lines.push(flags.join(" · "));
  if (c.comment) lines.push(c.comment);
  if (table) lines.push(`来自 \`${table}\``);
  return lines.join("\n\n");
}

/**
 * 关键字一句话说明。只收日常真会用到的那些——把 SQL 关键字全列一遍，
 * 悬停就变成了词典查询，反而挡视线。
 */
const KEYWORDS: Record<string, string> = {
  SELECT: "要取哪些列。`select a, b from t`",
  FROM: "数据从哪张表来。可以跟别名：`from bd_material m`",
  WHERE: "只保留满足条件的行。没有它，`update` / `delete` 会作用到整张表",
  JOIN: "把另一张表接进来，接的条件写在 `on` 后面",
  LEFT: "左连接：左边表的行全保留，右边没有匹配就补空",
  INNER: "内连接：两边都匹配上的行才留下",
  ON: "连接条件。漏写会变成笛卡尔积，行数相乘",
  GROUP: "按某几列分组，配合聚合函数用。`group by code, name`",
  ORDER: "结果排序。`order by ts desc` 让最新的在前",
  HAVING: "分组之后再筛。`where` 筛行，`having` 筛组",
  DISTINCT: "去掉重复行。写在 `select` 后面",
  UNION: "两个结果上下拼起来并去重；`union all` 不去重、更快",
  INSERT: "插入新行。列清单要写全，漏掉的列会走默认值",
  UPDATE: "改已有行。⚠️ 没有 `where` 就是改整张表",
  DELETE: "删已有行。⚠️ 没有 `where` 就是删整张表",
  MERGE: "按条件「有则更新、无则插入」，NC 的同步脚本常用",
  WITH: "先定义一个临时结果（CTE），后面可以反复用",
  EXISTS: "只判断有没有满足条件的行，比 `in` 更适合大子查询",
  IN: "值在给定集合里。集合很大时注意性能",
  LIKE: "模糊匹配。`%` 任意长度，`_` 单个字符",
  BETWEEN: "闭区间。日期用 `between` 要注意时分秒",
  CASE: "条件分支表达式，可以写在 `select` 里",
  NVL: "第一个为 null 时取第二个值。`nvl(code, '空')`",
  DECODE: "按值做映射，相当于简化的 `case`",
  ROWNUM: "Oracle 的行号，在 `order by` 之前分配——排序后截前 N 行要包一层子查询",
  ROWID: "行的物理地址，定位和去重时最可靠",
  SYSDATE: "数据库服务器的当前时间（含时分秒）",
  COMMIT: "把本会话的改动写进数据库。提交后不能回滚",
  ROLLBACK: "丢掉本会话还没提交的改动",
};

/** 关键字说明；不收的关键字返回 null（不弹空卡片）。 */
export function keywordHover(word: string): string | null {
  const text = KEYWORDS[word.toUpperCase()];
  return text ? `**${word.toUpperCase()}** — ${text}` : null;
}
