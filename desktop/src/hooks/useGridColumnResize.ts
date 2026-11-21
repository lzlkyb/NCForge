import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { fitWidth } from "../lib/resultView";
import type { Cell, ColumnMeta } from "../lib/dbApi";

/**
 * 列宽拖拽（列分隔线上按住左键拖动）与双击自适应（本列贴到内容宽度）。
 *
 * `widths` 状态本身留在调用方——新结果到达时「按列重建、换列才回顶」的那套逻辑
 * 属于组件生命周期；这里只持有拖拽期间的窗口监听与 `widthRef`（松手时与起点
 * 比较，宽度没变就不写布局，免得误点把自动宽度固化成手调值）。
 *
 * `dragCleanup` 同时是卸载兜底：切标签 / 结果清空时若拖拽还没结束，
 * 监听摘不掉就会打到下一个挂载的网格上。
 */
export function useGridColumnResize({ columns, rows, ws, widths, setWidths, onWidths }: {
  columns: ColumnMeta[];
  rows: Cell[][];
  /** 当前生效宽度：新结果第一帧 `widths` 还没重建，用的是现算的 fallback（见调用方 `ws`）。 */
  ws: number[];
  widths: number[];
  setWidths: Dispatch<SetStateAction<number[]>>;
  onWidths: (col: number, width: number) => void;
}) {
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const widthRef = useRef<number[]>([]);
  const [resizing, setResizing] = useState(false);
  const resize = (k: number, startX: number) => {
    const start = widths[k];
    dragCleanup.current?.();
    setResizing(true);
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      dragCleanup.current = null;
      setResizing(false);
      // 宽度没变（误点、双击 fit 的第一下）就别写布局，否则自动宽度会被固化成手调值。
      if (widthRef.current.length && widthRef.current[k] !== start) onWidths(k, widthRef.current[k]);
    };
    const move = (e: PointerEvent) => {
      // 指针被系统取消（Alt+Tab、触控笔离开、拖出窗口）时 pointerup 不触发；
      // buttons 归零是最后一道兜底，否则「手早松了，鼠标再动列宽还在变」。
      if (e.buttons === 0) return finish();
      setWidths(w=> {const next=w.map((x,i)=>i===k?Math.max(40,Math.min(900,start+e.clientX-startX)):x);widthRef.current=next;return next;});
    };
    dragCleanup.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };
  /** 双击列分隔线 = 本列贴到内容（列名优先），顺手记成手调宽度。 */
  const fit = (k: number) => { if (!columns[k]) return; const next = ws.map((w, i) => (i === k ? fitWidth(columns[k], rows, k) : w)); setWidths(next); onWidths(k, next[k]); };
  return { resizing, resize, fit };
}
