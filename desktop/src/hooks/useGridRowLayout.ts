import { useEffect, useMemo, useRef } from "react";
import {
  averageHeight, buildOffsets, offsetAt, rowAtOffset, rowHeights,
} from "../lib/gridRowMetrics";
import type { Cell, ColumnMeta } from "../lib/dbApi";

/**
 * 可变行高的虚拟滚动几何。
 *
 * 「每行等高」是手写虚拟滚动的前提，而自动换行会把某些行撑高。这个 hook 把
 * 行高（按 `rows` 下标）与偏移量（按 `order` 显示顺序）分开算：
 * 排序 / 筛选只重建前缀和，不重新测量文本；换行开关或列宽变化才重新测量。
 *
 * 调用方拿到的都是纯函数式入口（`offsetAt` / `rowAtOffset` / `range`），
 * 不要在渲染里直接摸 `offsets` 数组——那会让 `ResultGrid` 的几何散落两处。
 */
export function useGridRowLayout({ rows, columns, widths, order, wrap, rowH, frozen }: {
  rows: Cell[][];
  columns: ColumnMeta[];
  /** 实际渲染用的列宽（含手调值）。 */
  widths: number[];
  order: number[];
  wrap: boolean;
  rowH: number;
  /** 拖列宽期间冻结行高：每个 pointermove 都按新宽度重测所有行会让大表卡死。 */
  frozen?: boolean;
}) {
  const cached = useRef<number[] | null>(null);
  const heights = useMemo(
    () => (frozen && cached.current ? cached.current : rowHeights(rows, columns, widths, wrap, rowH)),
    [frozen, rows, columns, widths, wrap, rowH],
  );
  useEffect(() => { if (!frozen) cached.current = heights; }, [heights, frozen]);
  const { offsets, total } = useMemo(() => buildOffsets(heights, order), [heights, order]);
  const average = useMemo(() => averageHeight(total, order.length, rowH), [total, order.length, rowH]);

  return {
    /** 按 `rows` 下标的高度；换行关闭时全等于 `rowH`。 */
    heights,
    /** 表格内容总高（不含表头）。 */
    total,
    /** 平均行高：PageUp / PageDown 的「一屏多少行」用它。 */
    average,
    offsetAt: (index: number) => offsetAt(offsets, index),
    rowAtOffset: (y: number) => rowAtOffset(offsets, y),
    /**
     * 可视行区间（闭开区间 `[first, last)`）。上下各多留 `overscan` 行：
     * 按平均行高换算成 px，行高不固定时也能保证快滚不露白。
     */
    range: (top: number, height: number, overscan: number) => {
      const pad = average * overscan;
      const first = rowAtOffset(offsets, Math.max(0, top - pad));
      const last = Math.min(order.length, rowAtOffset(offsets, top + height + pad) + 2);
      return { first, last };
    },
  };
}
