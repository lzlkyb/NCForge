import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useAppHidden } from "../../lib/appVisibility";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { MOTION } from "../../lib/motion";

/** A single moving marker preserves selection continuity without moving text or rebuilding content. */
export function SelectionIndicator({ container, value, selector, variant = "rail", revision }: {
  container: RefObject<HTMLElement>; value: string; selector: string; variant?: "rail" | "tab"; revision?: unknown;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const animation = useRef<Animation>();
  const previous = useRef<HTMLElement>();
  const refresh = useRef<(animate: boolean) => void>(() => {});
  const reduced = usePrefersReducedMotion(), hidden = useAppHidden();
  useLayoutEffect(() => {
    const update = (animate: boolean) => {
      const host = container.current, node = marker.current;
      if (!host || !node) return;
      const target = host.querySelector<HTMLElement>(selector);
      if (!target || hidden) {
        animation.current?.cancel(); previous.current = undefined;
        delete host.dataset.motionSelectionReady; node.hidden = true; return;
      }
      const box = target.getBoundingClientRect(), parent = host.getBoundingClientRect();
      if (!box.width || !box.height) { node.hidden = true; delete host.dataset.motionSelectionReady; return; }
      const old = previous.current && !node.hidden ? node.getBoundingClientRect() : null;
      const sameGroup = previous.current?.parentElement === target.parentElement;
      animation.current?.cancel();
      const height = variant === "tab" ? 2 : box.height;
      const top = (variant === "tab" ? box.bottom - height : box.top) - parent.top + host.scrollTop - host.clientTop;
      Object.assign(node.style, { left: `${box.left - parent.left + host.scrollLeft - host.clientLeft}px`,
        top: `${top}px`, width: `${box.width}px`, height: `${height}px` });
      node.hidden = false; host.dataset.motionSelectionReady = "true";
      previous.current = target;
      if (!animate || !old || reduced || !node.animate) return;
      const destinationY = variant === "tab" ? box.bottom - height : box.top;
      const dx = old.left - box.left, dy = old.top - destinationY;
      const near = sameGroup && Math.abs(dx) + Math.abs(dy) <= (variant === "rail" ? 180 : host.clientWidth);
      animation.current = node.animate(near
        ? [{ transform: `translate(${dx}px,${dy}px) scale(${old.width / box.width},${old.height / height})`, opacity: .8 }, { transform: "none", opacity: 1 }]
        : [{ opacity: .6 }, { opacity: 1 }], { duration: MOTION.feedback, easing: MOTION.ease });
      void animation.current.finished.catch(() => {});
    };
    refresh.current = update;
    // Let sibling layout effects settle before measuring navigation; otherwise a marker can force
    // a second full layout when a retained editor surface becomes visible in the same commit.
    if (!previous.current || reduced || hidden) { update(false); return; }
    const frame = requestAnimationFrame(() => update(true));
    return () => cancelAnimationFrame(frame);
  }, [container, value, selector, variant, revision, reduced, hidden]);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    // An ancestor ref can attach after its child's layout effect; initialize after that commit too.
    refresh.current(false);
    let frame: number | undefined;
    const update = () => { if (!host.dataset.tabReflow) refresh.current(false); };
    const changed = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; update(); }); };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(host);
    const content = new MutationObserver(changed);
    content.observe(host, { childList: true, characterData: true, subtree: true });
    host.addEventListener("motion-layout-settled", update);
    return () => { observer?.disconnect(); content.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); host.removeEventListener("motion-layout-settled", update);
      animation.current?.cancel(); delete host.dataset.motionSelectionReady; };
  }, [container]);
  return <span ref={marker} aria-hidden="true" hidden className={`ui-selection-indicator ui-selection-${variant}`} />;
}
