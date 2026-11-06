import { useEffect, useRef } from "react";

/** 小型面板分隔条：指针与方向键共用有界值，双击恢复默认。 */
export function MetaSplitter({ value, min, max, label, horizontal = false, reverse = false, ratio = false, onChange, onReset }: {
  value: number; min: number; max: number; label: string; horizontal?: boolean; reverse?: boolean; ratio?: boolean;
  onChange: (value: number) => void; onReset: () => void;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => () => cleanup.current?.(), []);
  const apply = (next: number) => change.current(Math.max(min, Math.min(max, next)));
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation={horizontal ? "horizontal" : "vertical"}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    className={`meta-splitter ${horizontal ? "is-horizontal" : ""}`} onDoubleClick={onReset}
    onKeyDown={(e) => {
      const minus = horizontal ? "ArrowUp" : "ArrowLeft";
      const plus = horizontal ? "ArrowDown" : "ArrowRight";
      if (e.key === "Home") { e.preventDefault(); onReset(); }
      if (e.key !== minus && e.key !== plus) return;
      e.preventDefault();
      apply(value + (e.key === plus ? 1 : -1) * (reverse ? -1 : 1) * (ratio ? 0.03 : 12));
    }} onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      cleanup.current?.();
      const start = horizontal ? e.clientY : e.clientX;
      const extent = ratio ? e.currentTarget.parentElement?.clientHeight || 1 : 1;
      const move = (ev: PointerEvent) => apply(value + ((horizontal ? ev.clientY : ev.clientX) - start) / extent * (reverse ? -1 : 1));
      const end = () => { cleanup.current?.(); cleanup.current = null; };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
      window.addEventListener("pointercancel", end, { once: true });
      cleanup.current = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
    }} />;
}
