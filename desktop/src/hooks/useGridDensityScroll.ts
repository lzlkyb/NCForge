import { useLayoutEffect, useRef, type MutableRefObject, type RefObject } from "react";

/**
 * 切密度时保持当前首行。
 *
 * CSS 与虚拟滚动共用几何（`--dbx-row-h`）：密度一变总高就变，浏览器会先把
 * scrollTop 夹到新范围，首行当场跳走。这里按**总高比例**换算回写，
 * 换行模式（行高不固定）下同样成立——分母是累计高度，不是「行数 × 行高」。
 *
 * `previousTotal` 用 `null` 起步：首帧还没有可比的旧总高，直接用当前值，
 * 避免第一次切密度时按 0 除出一堆 NaN。
 */
export function useGridDensityScroll({ boxRef, rowH, total, preciseTop, onScrollTop }: {
  boxRef: RefObject<HTMLDivElement | null>;
  /** 当前行高（密度决定的那个值）。 */
  rowH: number;
  /** 当前内容总高（不含表头），换行模式下是累计高度。 */
  total: number;
  /** 精确 scrollTop（不受取整影响）：跨渲染保留，调用方持有。 */
  preciseTop: MutableRefObject<number>;
  /** 换算完后通知调用方同步 scroll 状态（top / 可视高度）。 */
  onScrollTop: (top: number, height: number) => void;
}) {
  const previousRowHeight = useRef(rowH);
  const previousTotal = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el && previousRowHeight.current !== rowH) {
      const before = previousTotal.current ?? total;
      el.scrollTop = before > 0 ? preciseTop.current / before * total : preciseTop.current;
      preciseTop.current = el.scrollTop;
      onScrollTop(el.scrollTop, el.clientHeight);
    }
    previousRowHeight.current = rowH;
    previousTotal.current = total;
  }, [boxRef, rowH, total, preciseTop, onScrollTop]);
}
