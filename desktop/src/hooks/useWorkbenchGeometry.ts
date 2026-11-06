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
  const resize = (axis: "side" | "bottom", start: number, value: number) => {
    cleanup.current?.();
    const move = (event: PointerEvent) => setSize(axis, value + (axis === "side" ? event.clientX - start : start - event.clientY));
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); cleanup.current = null; };
    cleanup.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
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
