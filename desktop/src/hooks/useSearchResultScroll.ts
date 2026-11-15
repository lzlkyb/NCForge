import { useLayoutEffect, useRef, type RefObject } from "react";
import { getSearchScrollTop } from "../lib/searchStore";

/** Restore after the inline/portal viewport has mounted and acquired its actual height. */
export function useSearchResultScroll(listRef: RefObject<HTMLDivElement>, identity: unknown) {
  const shown = useRef(identity);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const changed = shown.current !== identity;
    const saved = changed ? 0 : getSearchScrollTop();
    shown.current = identity;
    let frame = 0, restored = false;
    const restore = () => {
      if (restored || !list.clientHeight) return;
      if (!changed && saved === 0 && list.scrollTop > 0 && list.scrollTop !== saved) { restored = true; observer?.disconnect(); return; }
      list.scrollTop = saved;
      list.dispatchEvent(new Event("scroll"));
      restored = true;
      observer?.disconnect();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
    observer?.observe(list);
    if (list.isConnected && list.clientHeight) restore();
    else frame = requestAnimationFrame(restore);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [listRef, identity]);
}
