import { CELL_CHROME, textWidth } from "./resultView";
import type { Cell, ColumnMeta } from "./dbApi";

/**
 * 自动换行时的行高测量。
 *
 * 虚拟滚动假设「每行等高」：`dbx-grid-inner` 的总高、行的 `top`、`reveal` 的滚动定位
 * 全都建立在 `行号 × 行高` 上。一旦某些行因为换行变高，这三处必须换成「累计高度」，
 * 否则第 N 行会画到第 N-1 行的位置上去，键盘移动也会滚错地方。
 *
 * 所以这里只做一件事：把「这一行有多高」算成纯函数，几何计算全部交给调用方。
 * 测量与显示顺序解耦——**行高按 `rows` 下标算，偏移量按 `order` 累加**，
 * 这样排序 / 筛选只重建前缀和（O(n)），不必把每一行的文本重新测一遍。
 */

/** 换行后的行数上限。超出的部分留给 tooltip / F4，否则一条 8K 预览文本能把一屏撑满。 */
export const MAX_WRAP_LINES = 8;

/** 单元格左右 padding 各 10px，与 `.dbx-gc` 的 CSS 一致。 */
const SAFE_PAD = 4;

/**
 * 单字符宽度（px，13px `system-ui` 的近似值）。
 *
 * 故意与 `resultView` 的 `estimate` 用同一张表：**宁宽勿窄**——估算偏大只是多留
 * 一点空白，偏窄会把最后一个字裁掉。折行是逐字累加的，不能整串丢给 canvas。
 */
function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c > 0x2e80) return 13.5; // CJK / 全角标点
  if (c >= 48 && c <= 57) return 7.6; // 数字
  if (c >= 65 && c <= 90) return 9.4; // 大写
  if (c === 32) return 3.8; // 空格
  if (c === 10) return 0; // 换行由分段处理
  return 7.2; // 小写与常见符号
}

/**
 * 一段文本在宽度 `avail` 里占几行。显式 `\n` 一定断行，长行按字符宽度折。
 *
 * 快路径先整串测一次（`textWidth` 带缓存）：放得下就是 1 行，
 * 滚动时长文本只有第一次会走到逐字累加。
 */
export function wrapLineCount(text: string, avail: number): number {
  if (!text) return 1;
  if (avail <= 0) return MAX_WRAP_LINES;
  // 快路径只在没有显式换行时走：`measureText` 不认 `\n`（量出来是一行的宽度），
  // 带着换行符走快路径会把多行文本判成一行。
  if (!text.includes("\n") && textWidth(text) <= avail) return 1;
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    if (!paragraph) { lines += 1; continue; }
    let used = 0, n = 1;
    for (const ch of paragraph) {
      const w = charWidth(ch);
      // 英文单词中间不折（`word-break: break-word` 的近似）：只在超过宽度处断，
      // 与 CSS 的 `overflow-wrap: anywhere` 略有差别，但行数不会少算。
      if (used + w > avail && used > 0) { n += 1; used = w; } else used += w;
    }
    lines += n;
  }
  return Math.min(lines, MAX_WRAP_LINES);
}

/** 单元格里实际可用于文字的宽度（已扣 padding 与安全余量）。 */
export function wrapAvail(width: number): number {
  return Math.max(0, width - CELL_CHROME - SAFE_PAD);
}

/**
 * 每一行的高度（按 `rows` 下标）。`wrap` 关闭时全是 `rowH`——
 * 调用方因此不必为「换行 / 不换行」写两条几何路径。
 */
export function rowHeights(
  rows: Cell[][],
  columns: ColumnMeta[],
  widths: number[],
  wrap: boolean,
  rowH: number,
): number[] {
  if (!wrap) return rows.map(() => rowH);
  const avail = widths.map(wrapAvail);
  return rows.map(row => {
    let lines = 1;
    for (let c = 0; c < columns.length; c += 1) {
      const v = row?.[c];
      if (v === null || v === undefined) continue;
      const n = wrapLineCount(typeof v === "string" ? v : String(v), avail[c] ?? 0);
      if (n > lines) lines = n;
    }
    return lines * rowH;
  });
}

/** 按显示顺序累加前缀和：`offsets[i]` 是第 i 行（显示顺序）距表格顶部的距离。 */
export function buildOffsets(heights: number[], order: number[]): { offsets: number[]; total: number } {
  const offsets = new Array<number>(order.length);
  let total = 0;
  for (let i = 0; i < order.length; i += 1) { offsets[i] = total; total += heights[order[i]] ?? 0; }
  return { offsets, total };
}

/** 第 `index` 行（显示顺序）距顶部的 px。出界时夹在末尾之后，调用方自己判空。 */
export function offsetAt(offsets: number[], index: number): number {
  if (index < 0) return 0;
  return offsets[index] ?? offsets[offsets.length - 1] ?? 0;
}

/**
 * 滚动位置 `y` 落在哪一行（显示顺序）。二分：大表下一次滚动不能从头扫。
 * 落在两行之间时返回「上面那一行」——与 `Math.floor(y / rowH)` 的语义一致。
 */
export function rowAtOffset(offsets: number[], y: number): number {
  let lo = 0, hi = offsets.length - 1;
  if (hi < 0 || y <= 0) return 0;
  if (y >= offsets[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** 平均行高：翻页键（PageUp/PageDown）在行高不固定时按平均值算一屏多少行。 */
export function averageHeight(total: number, count: number, rowH: number): number {
  return count > 0 && total > 0 ? total / count : rowH;
}
