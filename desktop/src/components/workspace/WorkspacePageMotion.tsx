import { useLayoutEffect, useRef, type RefObject } from "react";
import { useAppHidden } from "../../lib/appVisibility";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { MOTION } from "../../lib/motion";

const targets: Record<string, string> = {
  files: '.wb-code-surface :is(.wb-tabs, .wb-crumb-row, .wb-empty-box)',
  db: '.wb-document-surface :is(.dbx-doctabs, .dbx-execution-bar, .dbx-result-head)',
  svn: '.wb-toolbar, .wb-document-surface :is(.vc-review-head, .vc-file-head, .vc-review-document .vc-empty)',
  meta: '.wb-document-surface .meta-workbench',
  logs: '.wb-document-surface .lg-page',
  settings: '.wb-document-surface .wb-settings-page',
};

/** Fade the incoming region while keeping editor and grid canvases fully readable. */
export function WorkspacePageMotion({ page, target }: { page: string; target: RefObject<HTMLDivElement> }) {
  const hidden = useAppHidden(), reduced = usePrefersReducedMotion();
  const previous = useRef(page);
  useLayoutEffect(() => {
    const changed = previous.current !== page;
    previous.current = page;
    const root = target.current;
    const selector = targets[page];
    if (!changed || !root || !selector || hidden || reduced || document.hidden) return;

    let waiting: MutationObserver | undefined;
    const animations: Animation[] = [];
    const play = () => {
      const skeleton = root.querySelector(`[data-workspace-skeleton="${page}"][data-loading-region="document"]`);
      if (skeleton && !skeleton.closest('[hidden]')) return false;
      const regions = [...root.querySelectorAll<HTMLElement>(selector)].filter(node => !node.closest('[hidden]'));
      if (!regions.length) return false;
      waiting?.disconnect();
      for (const region of regions) {
        const animation = region.animate?.([{ opacity: .86 }, { opacity: 1 }], { duration: MOTION.page, easing: MOTION.ease });
        if (!animation) continue;
        void animation.finished.catch(() => {});
        animations.push(animation);
      }
      return true;
    };
    // Cold routes animate only when the real dock content replaces the skeleton.
    if (!play()) {
      waiting = new MutationObserver(play);
      waiting.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    }
    return () => {
      waiting?.disconnect();
      for (const animation of animations) animation.cancel();
    };
  }, [page, target, hidden, reduced]);
  return null;
}
