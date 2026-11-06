import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "../../diagnostic-workspace.css";

/** Keep one result tree: moving its host preserves list scroll, previews and selection. */
export function SearchResultViewport({ expanded, onClose, children }: { expanded: boolean; onClose: () => void; children: ReactNode }) {
  const inline = useRef<HTMLDivElement>(null), full = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [container] = useState(() => document.createElement("div"));
  container.className = "dw-search-content";
  useLayoutEffect(() => {
    const target = expanded ? full.current : inline.current;
    if (!target || target === container.parentElement) return;
    const active = document.activeElement as HTMLElement | null;
    if (expanded) returnFocus.current = active;
    target.appendChild(container);
    const focus = active && container.contains(active) ? active : expanded ? container.querySelector<HTMLElement>("button") : returnFocus.current;
    focus?.focus({ preventScroll: true });
  }, [container, expanded]);
  useLayoutEffect(() => () => container.remove(), [container]);
  const closeOnEscape = (event: KeyboardEvent) => {
    if (expanded && event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  return <>
    <div className="dw-search-inline" ref={inline} hidden={expanded} />
    {createPortal(<section className="dw-search-expanded" hidden={!expanded} aria-label="展开的搜索结果" onKeyDown={closeOnEscape}><div ref={full} className="dw-search-expanded-body" /></section>, document.body)}
    {createPortal(<div className="dw-search-content" onKeyDown={closeOnEscape}>{children}</div>, container)}
  </>;
}
