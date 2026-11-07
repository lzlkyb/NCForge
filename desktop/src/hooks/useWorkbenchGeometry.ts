import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PanelTab } from "../components/workspace/BottomPanel";
import { getWorkbenchLayout, panelHeight, panelMaxHeight, updateWorkbenchLayout, useWorkbenchLayout } from "../lib/workbenchLayout";

export function useWorkbenchGeometry(panel: PanelTab, sideKey = "files") {
  const layout = useWorkbenchLayout();
  const [viewport, setViewport] = useState(() => window.innerHeight);
  const cleanup = useRef<(() => void) | null>(null);
  const enterAt = useRef({ side: -Infinity, bottom: -Infinity });
  useEffect(() => {
    const resized = () => setViewport(window.innerHeight);
    window.addEventListener("resize", resized);
    return () => { window.removeEventListener("resize", resized); cleanup.current?.(); };
  }, []);
  const bottomMax = panelMaxHeight(panel, viewport);
  const bottomHeight = panelHeight(layout, panel, viewport);
  const sideWidth = layout.sides[sideKey] ?? (sideKey === "search" ? 320 : layout.side);
  const setSize = (axis: "side" | "bottom", value: number) => axis === "side"
    ? updateWorkbenchLayout({ sides: { ...getWorkbenchLayout().sides, [sideKey]: Math.max(180, Math.min(420, value)) } })
    : updateWorkbenchLayout({ compact: false, heights: { ...getWorkbenchLayout().heights, [panel]: Math.max(140, Math.min(bottomMax, value)) } });
  /**
   * `capture` 来自手柄的 pointerdown：指针捕获保证拖出 WebView 之后仍能收到
   * pointermove / pointerup。原先只监听 window，指针在窗口外松手会丢掉 pointerup，
   * `pointermove` 常驻，回到窗口后继续改宽度（幽灵拖拽）。
   */
  const resize = (axis: "side" | "bottom", start: number, value: number, capture?: { id: number; element: HTMLElement }) => {
    cleanup.current?.();
    const captureEl = capture?.element;
    if (capture) {
      try { captureEl?.setPointerCapture(capture.id); } catch { /* 指针已释放，退回 window 监听 */ }
    }
    const move = (event: PointerEvent) => {
      if (capture && event.pointerId !== capture.id) return;
      setSize(axis, value + (axis === "side" ? event.clientX - start : start - event.clientY));
    };
    const finish = (event?: Event) => {
      const pe = event instanceof PointerEvent ? event : undefined;
      if (capture && pe && pe.pointerId !== capture.id) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("lostpointercapture", finish);
      if (capture) {
        try { captureEl?.releasePointerCapture(capture.id); } catch { /* 已自动释放 */ }
      }
      cleanup.current = null;
    };
    cleanup.current = () => finish();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("lostpointercapture", finish);
  };
  const onSeparatorKey = (event: KeyboardEvent, axis: "side" | "bottom") => {
    if (event.key === "Enter") {
      event.preventDefault(); const now = performance.now();
      if (now - enterAt.current[axis] < 600) { setSize(axis, axis === "side" ? sideKey === "search" ? 320 : 240 : panel === "svc" ? 360 : panel === "debug" ? 260 : 200); enterAt.current[axis] = -Infinity; }
      else enterAt.current[axis] = now;
      return;
    }
    const grow = axis === "side" ? "ArrowRight" : "ArrowUp", shrink = axis === "side" ? "ArrowLeft" : "ArrowDown";
    if (event.key !== grow && event.key !== shrink) return;
    event.preventDefault(); setSize(axis, (axis === "side" ? sideWidth : bottomHeight) + (event.key === grow ? 10 : -10));
  };
  return { layout, sideWidth, bottomHeight, bottomMax, resize, onSeparatorKey };
}
