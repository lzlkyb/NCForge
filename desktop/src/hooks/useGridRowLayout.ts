import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getFontRevision, subscribeFonts } from "../lib/fonts";
import {
  averageHeight, buildOffsets, offsetAt, rowAtOffset, rowHeights,
} from "../lib/gridRowMetrics";
import type { Cell, ColumnMeta } from "../lib/dbApi";

const FIXED_HEIGHTS: number[] = [];

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
  const cached = useRef<{ heights: number[]; fontRevision: number; wrap: boolean } | null>(null);
  const fontRevision = useSyncExternalStore(subscribeFonts, getFontRevision);
  // Store the font generation with the measurement so a swap also refreshes wrapped row geometry.
  const measurement = useMemo(
    () => (frozen && cached.current?.wrap === wrap ? cached.current : { heights: wrap ? rowHeights(rows, columns, widths, true, rowH) : FIXED_HEIGHTS, fontRevision, wrap }),
    [frozen, rows, columns, widths, wrap, rowH, fontRevision],
  );
  const { heights } = measurement;
  useEffect(() => { if (!frozen) cached.current = measurement; }, [measurement, frozen]);
  const geometry = useMemo(() => wrap ? buildOffsets(heights, order) : null, [heights, order, wrap]);
  const total = geometry?.total ?? order.length * rowH;
  const average = averageHeight(total, order.length, rowH);
  const indexAt = (y: number) => geometry ? rowAtOffset(geometry.offsets, y) : Math.min(Math.max(0, order.length - 1), Math.max(0, Math.floor(y / rowH)));

  return {
    /** 仅在换行时存各行高度，等高网格用行号直接计算几何。 */
    heights,
    /** 表格内容总高（不含表头）。 */
    total,
    /** 平均行高：PageUp / PageDown 的「一屏多少行」用它。 */
    average,
    offsetAt: (index: number) => geometry ? offsetAt(geometry.offsets, index) : Math.max(0, Math.min(index, order.length - 1)) * rowH,
    rowAtOffset: indexAt,
    /**
     * 可视行区间（闭开区间 `[first, last)`）。上下各多留 `overscan` 行：
     * 按平均行高换算成 px，行高不固定时也能保证快滚不露白。
     */
    range: (top: number, height: number, overscan: number) => {
      const pad = average * overscan;
      const first = indexAt(Math.max(0, top - pad));
      const last = Math.min(order.length, indexAt(top + height + pad) + 2);
      return { first, last };
    },
  };
}
