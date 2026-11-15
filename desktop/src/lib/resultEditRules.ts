import { isLobPreview, sameCell } from "./db";
import type { Cell, ColumnMeta } from "./dbApi";
import { editableCellType } from "./sqlEditable";

/**
 * 网格（结果页 / 表页）里「这一格能不能改」「为什么不能改」的纯判断。
 *
 * 抽出来的原因只有一个：这些规则要能被单测直接钉住，且不跟着 hook 的状态一起膨胀。
 * 判断本身不碰任何状态，输入全是当次渲染的快照。
 */
export interface CellRuleContext {
  columns: ColumnMeta[];
  /** 显示行基线（已叠加写回后的覆盖值）。 */
  baseline: Cell[][];
  /** 已有行数；`row >= base` 是新增草稿行。 */
  base: number;
  /** 定位列（主键 / ROWID）：改了会定位不到原行。 */
  locked: Set<number>;
  rowidCol: number;
  /** 结果列对应的表列名；计算结果列返回空。 */
  sourceName: (col: number) => string | null | undefined;
  /** 同一表列在结果里出现多次时的其它下标（`select t.id, t.*`）。 */
  twinsOf: (col: number) => number[];
}

export function canEditCell(ctx: CellRuleContext, col: number, row?: number): boolean {
  const column = ctx.columns[col];
  if (!column || !editableCellType(column.type) || !ctx.sourceName(col)) return false;
  // 新增草稿行要允许填主键列（新行的定位靠它）；已有行的定位列不能改。
  if (row !== undefined && row >= ctx.base) return true;
  // 大文本预览只是前 8K + 一段说明，改它既写不回原值也会把说明当成数据。
  if (row !== undefined && isLobPreview(ctx.baseline[row]?.[col] ?? null)) return false;
  return !ctx.locked.has(col);
}

/** 可编辑结果里也有锁住的列：双击要说出这一格自己的原因，不能静默。 */
export function blockedCellReason(ctx: CellRuleContext, col: number, row?: number): string {
  const column = ctx.columns[col];
  if (!column) return "这一列不在结果里";
  if (col === ctx.rowidCol) return "ROWID 是行标识列，不能当数据改";
  if (!editableCellType(column.type)) return `「${column.name}」是 ${column.type} 类型，网格里不能直接改；请用 SQL 更新`;
  if (!ctx.sourceName(col)) return `「${column.name}」是计算结果或对不上表列，改它没有对应的表列`;
  if (row !== undefined && row >= ctx.base) return "";
  if (row !== undefined && isLobPreview(ctx.baseline[row]?.[col] ?? null)) {
    return "这一格是大文本预览（只显示前 8K），不能在这里改；按 F4 查看完整值";
  }
  if (ctx.locked.has(col)) return `「${column.name}」是定位列，改了会定位不到原行`;
  return "";
}

/**
 * 同一个表列在结果里出现多次时，几格必须一起改：写回只改一个表列，
 * 不给另一格同步，同一次修改里就会一格新、一格旧。
 */
export function writeCellWithTwins(
  ctx: Pick<CellRuleContext, "baseline" | "twinsOf">,
  next: Map<string, Cell>,
  row: number,
  col: number,
  value: Cell,
): void {
  for (const c of [col, ...ctx.twinsOf(col)]) {
    if (sameCell(value, ctx.baseline[row]?.[c] ?? null)) next.delete(`${row}:${c}`);
    else next.set(`${row}:${c}`, value);
  }
}
