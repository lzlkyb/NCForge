import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { edgeSpeed, trackSelectionDrag } from "../lib/dragEdgeScroll";
import type { CellPos } from "../components/db/gridEdit";
import type { SortState } from "../lib/resultView";

/** 列几何：命中测试只要「左缘 / 吸附位 / 宽 / 是否冻结」，由调用方的 columnViewport 结果提供。 */
type DragColumn = { column: number; left: number; sticky: number; width: number; frozen: boolean };

/**
 * 网格里的鼠标框选：在单元格上按住左键拖动，按指针位置连续扩展选区；
 * 推到视口边缘时按 `edgeSpeed` 自动滚动（指针不动选区也继续长）。
 *
 * 拖拽中要读的「当前 order / layout / 列几何 / onSel」放在 `dragLayout` ref 里
 * 每次渲染刷新——窗口监听是 pointerdown 时建一次的，直接闭包会粘住旧值。
 * order 真变了（排序 / 筛选重排显示顺序）就地取消拖拽：旧 order 的下标已经
 * 不存在，继续扩选会选到别的行。
 */
export function useGridSelectionDrag({ rnW, headH, fullColumns, order, layout, onSel, visible, sort }: {
  rnW: number;
  headH: number;
  fullColumns: DragColumn[];
  order: number[];
  layout: { rowAtOffset: (index: number) => number };
  onSel: (pos: CellPos, extend?: boolean) => void;
  visible: number[];
  sort: SortState | null;
}) {
  const selectionDrag = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => selectionDrag.current?.(), [visible, sort?.col, sort?.dir]);
  const dragLayout = useRef({ order, layout, fullColumns, onSel });
  useLayoutEffect(() => {
    const previous = dragLayout.current.order;
    if (previous !== order && (previous.length > order.length || previous.some((row, index) => order[index] !== row))) selectionDrag.current?.();
    dragLayout.current = { order, layout, fullColumns, onSel };
  }, [order, layout, fullColumns, onSel]);
  const startSelectionDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = event.currentTarget, win = node.ownerDocument.defaultView;
    const hit = (event.target as HTMLElement).closest("[role=gridcell]");
    if (!win || event.button !== 0 || event.pointerType !== "mouse" || !hit?.classList.contains("dbx-gc") || (event.target as HTMLElement).closest("button,input,textarea")) return;
    selectionDrag.current?.();
    let point = event.nativeEvent, vx = 0, vy = 0, last: CellPos | undefined;
    let left = node.scrollLeft, top = node.scrollTop;
    const frozenEdge = rnW + fullColumns.reduce((total, col) => total + (col.frozen ? col.width : 0), 0);
    const extendToPointer = () => {
      const { order, layout, fullColumns, onSel } = dragLayout.current;
      const rect = node.getBoundingClientRect();
      if (!node.clientHeight || !order.length) { selectionDrag.current?.(); return; }
      const y = Math.max(headH, Math.min(node.clientHeight - 1, point.clientY - rect.top));
      const r = order[layout.rowAtOffset(node.scrollTop + y - headH)];
      const x = Math.max(rnW, Math.min(node.clientWidth - 1, point.clientX - rect.left));
      const frozen = vx >= 0 || node.scrollLeft === 0 ? fullColumns.find(col => col.frozen && x >= col.sticky && x < col.sticky + col.width) : undefined;
      const contentX = node.scrollLeft + Math.max(x, Math.min(frozenEdge, node.clientWidth - 1));
      const col = frozen ?? fullColumns.find(col => !col.frozen && contentX < col.left + col.width) ?? fullColumns[fullColumns.length - 1];
      if (col && (last?.r !== r || last.c !== col.column)) { last = { r, c: col.column }; onSel(last, true); }
    };
    selectionDrag.current = trackSelectionDrag(win, event.pointerId, move => {
      const rect = node.getBoundingClientRect();
      if (!node.clientHeight) { selectionDrag.current?.(); return false; }
      point = move;
      const edge = Math.min(20, node.clientHeight / 4);
      vx = edgeSpeed(move.clientX, rect.left + Math.min(frozenEdge, node.clientWidth - edge * 2), rect.left + node.clientWidth, edge);
      vy = edgeSpeed(move.clientY, rect.top + headH, rect.top + node.clientHeight, edge);
      left = node.scrollLeft; top = node.scrollTop;
      extendToPointer();
      return !!(vx || vy);
    }, seconds => {
      left = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, left + vx * seconds));
      top = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, top + vy * seconds));
      node.scrollLeft = left; node.scrollTop = top;
      extendToPointer();
    });
  };
  return startSelectionDrag;
}
