import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { hitNode, type NodeShape, type Pos } from "../components/meta/canvasLayout";

type PointerState = { mode: "move"; id: string; dx: number; dy: number } | { mode: "link"; from: string; x: number; y: number };

/** 每帧至多提交一次移动；拖动期监听只挂一次，坐标和回调从 ref 读取。 */
export function useMetaCanvasPointer({ wrapRef, positions, shapes, ids, zoom, enabled, onMove, onSelect, onLink }: {
  wrapRef: RefObject<HTMLDivElement>; positions: Pos[]; shapes: NodeShape[]; ids: string[]; zoom: number; enabled: boolean;
  onMove: (id: string, pos: Pos) => void; onSelect: (id: string) => void; onLink: (source: string, target: string) => void;
}) {
  const [pointer, setPointer] = useState<PointerState | null>(null);
  const latest = useRef({ positions, shapes, ids, zoom, enabled, onMove, onSelect, onLink });
  latest.current = { positions, shapes, ids, zoom, enabled, onMove, onSelect, onLink };
  const active = useRef<PointerState | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const local = useCallback((e: { clientX: number; clientY: number }) => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    return { x: (e.clientX - rect.left + wrap.scrollLeft) / latest.current.zoom, y: (e.clientY - rect.top + wrap.scrollTop) / latest.current.zoom };
  }, [wrapRef]);
  useEffect(() => () => cleanup.current?.(), []);
  const start = useCallback((e: ReactPointerEvent<SVGGElement>, id: string, mode: "move" | "link") => {
    if (!latest.current.enabled || e.button > 0) return;
    const pt = local(e);
    const index = latest.current.ids.indexOf(id);
    if (!pt || index < 0) return;
    e.preventDefault();
    cleanup.current?.();
    const position = latest.current.positions[index];
    active.current = mode === "move" ? { mode, id, dx: pt.x - position.x, dy: pt.y - position.y } : { mode, from: id, ...pt };
    setPointer(active.current);
    latest.current.onSelect(id);
    let frame: number | null = null;
    let pending: Pos | null = null;
    const flush = () => {
      frame = null;
      const drag = active.current;
      if (!drag || !pending) return;
      if (drag.mode === "move") latest.current.onMove(drag.id, { x: Math.max(0, pending.x - drag.dx), y: Math.max(0, pending.y - drag.dy) });
      else setPointer({ ...drag, ...pending });
    };
    const move = (ev: PointerEvent) => { pending = local(ev); if (frame == null) frame = requestAnimationFrame(flush); };
    const up = (ev: PointerEvent) => {
      if (frame != null) cancelAnimationFrame(frame);
      pending = local(ev);
      flush();
      const drag = active.current;
      if (drag?.mode === "link" && pending) {
        const hit = hitNode(latest.current.positions, latest.current.shapes, pending);
        const target = latest.current.ids[hit];
        if (target && target !== drag.from) latest.current.onLink(drag.from, target);
      }
      active.current = null;
      setPointer(null);
      cleanup.current?.();
    };
    const cancel = () => { active.current = null; setPointer(null); cleanup.current?.(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    cleanup.current = () => {
      if (frame != null) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [local]);
  const startMove = useCallback((e: ReactPointerEvent<SVGGElement>, id: string) => start(e, id, "move"), [start]);
  const startLink = useCallback((e: ReactPointerEvent<SVGGElement>, id: string) => start(e, id, "link"), [start]);
  return { pointer, startMove, startLink };
}
