import type { Cell } from "./dbApi";
import { isLobPreview } from "./db";

/**
 * 「这一格在网格里一定显示不全」的唯一判据。
 *
 * WHY 要收敛成一个函数：这个判据曾经有三份（`GridRows` 的角标只认 4K/预览、
 * `cellCodec.title` 又按列宽另算、双击完全不看），结果 VARCHAR2(2000) 的报错堆栈
 * 既不亮角标、悬停文案还写着「双击看详情」—— 而双击其实是编辑。
 * 现在角标 / 「…」按钮 / 双击分流 / 悬停文案全部读这里。
 */
export const CELL_TEXT_MAX = 300;

/**
 * 格子里的值会不会超出网格能显示的长度（含多行与后端 8K 预览）。
 *
 * `wrapped` 是网格当前的「自动换行」开关：开了换行，多行值本来就能完整看到，
 * 只有被 `CELL_TEXT_MAX` 截断或后端只带预览时才算显示不全——否则每个多行格
 * 都会多一个「…」按钮，还会挤掉 18px 文本宽度。
 */
export function isWideText(v: Cell, wrapped = false): boolean {
  if (typeof v !== "string" || v.length === 0) return false;
  // 含换行：单行网格既读不出结构（JSON / 报错堆栈 / SQL），也一定显示不全。
  if (!wrapped && (v.includes("\n") || v.includes("\r"))) return true;
  if (v.length > CELL_TEXT_MAX) return true;
  // 后端只带了前 8K（CLOB/长 VARCHAR2）：尾部还有一段中文说明，多长都是不全的。
  // 放最后一句：`isLobPreview` 是类型谓词，当条件会把 v 收窄成 never
  // （CellDetail 早先踩过同一个坑），这里不再接任何 `.length` / `.includes`。
  return isLobPreview(v);
}
