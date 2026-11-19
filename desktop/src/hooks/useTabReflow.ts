import { useLayoutEffect, useRef, type RefObject } from "react";
import { useAppHidden } from "../lib/appVisibility";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { MOTION } from "../lib/motion";

/** Only closing tabs repositions retained labels. Pixel scrolling and typing never enter this path. */
export function useTabReflow(container: RefObject<HTMLElement>, signature: string) {
  const previous = useRef(new Map<string, { left: number; node: HTMLElement }>());
  const animations = useRef(new Map<HTMLElement, Animation>());
  const hidden = useAppHidden(), reduced = usePrefersReducedMotion();
  useLayoutEffect(() => {
    const host = container.current; if (!host) return;
    const bounds = host.getBoundingClientRect();
    const nodes = [...host.querySelectorAll<HTMLElement>('[role="tab"][data-path]')];
    const closing = previous.current.size > nodes.length;
    const next = new Map<string, { left: number; node: HTMLElement }>();
    for (const node of nodes) {
      const box = node.getBoundingClientRect();
      const old = previous.current.get(node.dataset.path!);
      const transform = animations.current.has(node) && typeof DOMMatrixReadOnly !== "undefined"
        ? new DOMMatrixReadOnly(getComputedStyle(node).transform).m41 : 0;
      animations.current.get(node)?.cancel(); animations.current.delete(node);
      const left = box.left - transform;
      next.set(node.dataset.path!, { left, node });
      if (!closing || !old || reduced || hidden || !node.animate || box.right < bounds.left || box.left > bounds.right) continue;
      const delta = old.left + transform - left;
      if (Math.abs(delta) < .5 || Math.abs(delta) > bounds.width) continue;
      const animation = node.animate([{ transform: `translateX(${delta}px)` }, { transform: "none" }], { duration: MOTION.feedback, easing: MOTION.ease });
      animations.current.set(node, animation);
      host.dataset.tabReflow = "true";
      void animation.finished.catch(() => {}).then(() => {
        if (animations.current.get(node) === animation) animations.current.delete(node);
        if (!animations.current.size) { delete host.dataset.tabReflow; host.dispatchEvent(new Event("motion-layout-settled")); }
      });
    }
    for (const [key, old] of previous.current) if (!next.has(key)) { animations.current.get(old.node)?.cancel(); animations.current.delete(old.node); }
    previous.current = next;
  }, [container, signature, hidden, reduced]);
  useLayoutEffect(() => {
    const running = animations.current;
    return () => { running.forEach(animation => animation.cancel()); running.clear(); };
  }, []);
}
