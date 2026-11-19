import { useLayoutEffect, useRef, type RefObject } from "react";
import { useAppHidden } from "../../lib/appVisibility";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { MOTION } from "../../lib/motion";

/** Navigation acknowledges the selected label; code and result canvases stay fully readable. */
export function WorkspacePageMotion({ page, target }: { page: string; target: RefObject<HTMLDivElement> }) {
  const hidden = useAppHidden(), reduced = usePrefersReducedMotion();
  const previous = useRef(page);
  useLayoutEffect(() => {
    const changed = previous.current !== page; previous.current = page;
    const surface = target.current?.querySelector('.wb-code-surface:not([hidden]), .wb-document-surface:not([hidden])');
    const element = surface?.querySelector<HTMLElement>('.wb-tab[data-active], .dbx-doctab[data-active]');
    if (!changed || !element?.animate || hidden || reduced || document.hidden) return;
    const style = getComputedStyle(document.documentElement);
    const timing = style.getPropertyValue("--dur-fast").trim();
    const value = Number.parseFloat(timing);
    if (!Number.isFinite(value)) return;
    const animation = element.animate([{ opacity: .85 }, { opacity: 1 }], {
      duration: timing.endsWith("ms") ? value : value * 1000,
      easing: style.getPropertyValue("--ease").trim() || MOTION.ease,
    });
    void animation.finished.catch(() => {});
    return () => animation.cancel();
    // 只提示所到位置，正文及其草稿始终保留在原节点且不淡出。
  }, [page, target, hidden, reduced]);
  return null;
}
