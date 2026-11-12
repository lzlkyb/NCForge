import { isLobPreview } from "./db";
import type { Cell, ColumnMeta } from "./dbApi";

/**
 * 表页「这一格能不能改」的判据，以及不能改时对人怎么说。
 *
 * 以前这段散在 `TableData` 的 `canEdit`、`blockedHint`、页脚 hint 三处：同一个口径
 * 写三遍，改一处就漏两处（页脚说「没有主键，只读」，双击却弹出「正在查询」）。
 * 抽出来既守住 300 行红线，也让「为什么不能改」只有一份答案。
 *
 * 两个层次要分清：
 * - **结构性**原因（只读连接 / 视图 / 没主键）：跟当时在不在查询无关，双击时要明说；
 * - **临时性**状态（正在查询、正在写回、事务待核对）：只是此刻不让改，不该弹提示。
 */

/** 能在网格里直接改的类型。带时区的时间戳不列入：写回时格式说不清，容易写错值。 */
const EDITABLE_TYPE = /^(VARCHAR|NVARCHAR|CHAR|NCHAR|NUMBER|FLOAT|INTEGER|DECIMAL|DATE|TIMESTAMP|CLOB)/i;

export function tableCellEditable(
  columns: ColumnMeta[], rows: Cell[][], pk: string[], c: number, r?: number,
): boolean {
  const col = columns[c];
  if (!col || /TIME ZONE/i.test(col.type) || !EDITABLE_TYPE.test(col.type)) return false;
  // 大文本预览只有前 8K + 一段说明：改它写不回原值，只会把说明当数据写进去。
  if (r !== undefined && r < rows.length && isLobPreview(rows[r]?.[c] ?? null)) return false;
  // 新增行还没进库，主键列必须能填（否则新增记录永远缺主键）；已有行不能改主键。
  return (r !== undefined && r >= rows.length) || !pk.includes(col.name);
}

/** 双击不可编辑的格子时说的那句话；临时性状态不弹（返回 undefined）。 */
export function tableBlockedHint(o: { readonly: boolean | null; isView: boolean; pk: string[] }): string | undefined {
  if (o.readonly) return "当前连接是只读模式";
  if (o.isView) return "视图不能直接改数据";
  if (o.pk.length === 0) return "这张表没有主键，定位不到唯一行";
  return undefined;
}

/** 页脚那行说明：能不能改 + 不能改的原因 + 等待上限。 */
export function tableFootHint(o: {
  readonly: boolean | null; isView: boolean; pk: string[]; editable: boolean; timeoutSec: number;
}): string {
  const state =
    o.readonly ? "只读查询模式"
      : o.isView ? "视图只读"
        : o.pk.length === 0 ? "没有主键，只读（定位不到唯一行）"
          : o.editable ? "双击单元格编辑（主键列不可改）· F4 看完整值"
            : "暂时不可编辑（正在查询或写回）";
  return `${state} · 等待上限 ${o.timeoutSec}s`;
}
