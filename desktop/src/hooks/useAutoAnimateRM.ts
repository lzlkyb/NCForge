import { useCallback, useEffect, useState, type RefCallback } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { useAppHidden } from "../lib/appVisibility";
import { MOTION } from "../lib/motion";

/** Toast-stack layout motion. Event-driven WAAPI avoids the old library's idle polling. */
export function useAutoAnimateRM<T extends HTMLElement = HTMLDivElement>(enabled = true): RefCallback<T> {
  const [parent, setParent] = useState<T | null>(null);
  const reduced = usePrefersReducedMotion(), hidden = useAppHidden();
  useEffect(() => {
    if (!parent || !enabled || reduced || hidden) return;
    const positions = new Map<HTMLElement, number>();
    const animations = new Map<HTMLElement, Animation>();
    let frame: number | undefined;
    let disposed = false;
    const measure = () => {
      frame = undefined;
      if (disposed) return;
      const children = new Set([...parent.children].filter((child): child is HTMLElement => child instanceof HTMLElement));
      for (const child of positions.keys()) if (!children.has(child)) {
        animations.get(child)?.cancel(); animations.delete(child); positions.delete(child); resize?.unobserve(child);
      }
      for (const child of children) {
        // `translate` composes with the toast's own CSS transform entrance/exit.
        const translated = getComputedStyle(child).translate?.split(" ")[1];
        const offset = Number.parseFloat(translated ?? "0") || 0;
        // Scrolling a long error stack must not be mistaken for a layout change.
        const top = child.getBoundingClientRect().top - offset + parent.scrollTop;
        const previous = positions.get(child);
        if (previous === undefined) resize?.observe(child);
        positions.set(child, top);
        if (previous === undefined || Math.abs(previous - top) < .5 || !child.animate) continue;
        animations.get(child)?.cancel();
        const animation = child.animate([{ translate: `0px ${previous - top + offset}px` }, { translate: "0px 0px" }], {
          duration: MOTION.standard, easing: MOTION.ease,
        });
        animations.set(child, animation);
        void animation.finished.then(() => { if (animations.get(child) === animation) animations.delete(child); }, () => {});
      }
    };
    // At most one frame per mutation/resize batch. No recurring frame or timer is scheduled.
    const schedule = () => { if (!disposed && frame === undefined) frame = requestAnimationFrame(measure); };
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    const mutation = new MutationObserver(schedule);
    measure(); resize?.observe(parent); mutation.observe(parent, { childList: true });
    return () => {
      disposed = true;
      mutation.disconnect(); resize?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      animations.forEach(animation => animation.cancel());
      animations.clear(); positions.clear();
    };
  }, [parent, enabled, reduced, hidden]);
  return useCallback((node: T | null) => setParent(node), []);
}
