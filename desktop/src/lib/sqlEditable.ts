/**
 * 判断一条查询的结果能不能「改回基表」——SQL 控制台结果页双击编辑的前提。
 *
 * 表的识别在 `sqlSource.ts`（词法扫描 + 顶层 FROM + 输出列映射），这里只负责
 * 结果能不能定位到唯一一行：主键、rowid、或用户手动指定的定位列。
 *
 * 口径仍然保守：没有可靠行标识就不给编辑入口。所有拒绝都带一句人话，
 * 界面直接显示这句话，用户知道为什么不能改。
 */
import { analyzeSql } from "./sqlSource";

export interface EditableSource {
  /** 可编辑时的基表名（可能是 `schema.table`）；不可编辑为 null。 */
  table: string | null;
  /** 不可编辑的原因，直接给用户看。可编辑时为空串。 */
  reason: string;
}

export function editableSource(sql: string): EditableSource {
  const source = analyzeSql(sql);
  return { table: source.table, reason: source.table ? "" : source.reason };
}

export interface EditKeyInfo {
  /** 定位列的表列名（大写）；rowid 定位时为空。 */
  keys: string[];
  /** 定位列在结果里的下标。 */
  keyCols: number[];
  kind: "pk" | "rowid" | "custom" | null;
  reason: string;
  /** 主键里结果没有的列。 */
  missing: string[];
}

/**
 * 结果里必须**带上全部主键列**才能改：缺一列就定位不到唯一行。
 *
 * `sourceName` 把结果列映射回表列：`select code as 编码` 之后，主键 `CODE`
 * 仍然要能对上结果里的「编码」那一列。返回的是结果列下标，写回时不再按列名猜。
 */
export function editableIdentity(
  columns: { name: string }[],
  pk: string[],
  sourceName: (col: number) => string | null,
  rowidCol = -1,
): EditKeyInfo {
  if (rowidCol >= 0) return { keys: ["ROWID"], keyCols: [], kind: "rowid", reason: "", missing: [] };
  if (!pk.length) return { keys: [], keyCols: [], kind: null, reason: "这张表没有主键，定位不到唯一行", missing: [] };
  const keyCols: number[] = [];
  const missing: string[] = [];
  for (const name of pk) {
    const wanted = name.toUpperCase();
    const hits = columns.flatMap((_, i) => (sourceName(i)?.toUpperCase() === wanted ? [i] : []));
    if (!hits.length) missing.push(wanted);
    else if (hits.length > 1) {
      return { keys: [], keyCols: [], kind: null, reason: `结果里有多列对应主键 ${wanted}，定位不唯一`, missing: [] };
    } else keyCols.push(hits[0]);
  }
  if (missing.length) {
    return {
      keys: [], keyCols: [], kind: null, missing,
      reason: `结果里没有主键列 ${missing.join("、")}，定位不到唯一行`,
    };
  }
  return { keys: pk.map(k => k.toUpperCase()), keyCols, kind: "pk", reason: "", missing: [] };
}

/** 用户手动指定的定位列（DBeaver virtual key 思路）：没有主键时的兜底。 */
export function editableCustomKeys(
  columns: { name: string }[],
  selected: string[],
  sourceName: (col: number) => string | null,
): EditKeyInfo {
  const names = selected.map(n => n.toUpperCase()).filter(Boolean);
  if (!names.length) return { keys: [], keyCols: [], kind: null, reason: "还没有选择定位列", missing: [] };
  const keyCols: number[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const index = columns.findIndex(c => c.name.toUpperCase() === name);
    if (index < 0 || !sourceName(index)) missing.push(name);
    else keyCols.push(index);
  }
  if (missing.length) {
    return { keys: [], keyCols: [], kind: null, missing, reason: `选中的定位列 ${missing.join("、")} 不能写回表列` };
  }
  return { keys: names, keyCols, kind: "custom", reason: "", missing: [] };
}

/** 老接口：只按结果列名匹配主键（表页 / 旧调用方继续使用）。 */
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
