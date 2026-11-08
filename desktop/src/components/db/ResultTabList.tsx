import { useEffect, useRef, type ReactNode } from "react";

export type ResultTabOption = { id: string; label: ReactNode; title?: string };
export const resultTabId = (prefix: string, value: string) => `${prefix}-tab-${encodeURIComponent(value)}`;

/** Results and implicit result sets share one keyboard model without entering every tab in the Tab order. */
export function ResultTabList({ prefix, label, items, value, onSelect }: {
  prefix: string; label: string; items: ResultTabOption[]; value: string; onSelect: (id: string) => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => { refs.current.get(value)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [value]);
  return <div className="dbx-rtabs" role="tablist" aria-label={label}>
    {items.map((item, index) => <button key={item.id} type="button" role="tab"
      id={resultTabId(prefix, item.id)} aria-controls={`${prefix}-panel`}
      aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1}
      className="dbx-rtab" data-on={value === item.id || undefined} title={item.title}
      ref={el => { if (el) refs.current.set(item.id, el); else refs.current.delete(item.id); }}
      onClick={() => onSelect(item.id)} onKeyDown={event => {
        if (event.key === "ArrowDown") {
          event.preventDefault(); document.getElementById(`${prefix}-panel`)?.focus(); return;
        }
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : event.key === "ArrowRight" ? (index + 1) % items.length
          : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length : -1;
        if (next < 0) return;
        event.preventDefault(); onSelect(items[next].id); refs.current.get(items[next].id)?.focus();
      }}>{item.label}</button>)}
  </div>;
}
