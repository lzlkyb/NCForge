import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ResultFileGroup, ResultHit } from "../../lib/searchResults";
import { resultHitKey } from "../../lib/searchNavigation";
import { ResultFile } from "./ResultFile";

type Row = { key: string; group: ResultFileGroup; hit?: ResultHit; project?: boolean; top: number; height: number };
/** Only visible rows own DOM; keyboard navigation still addresses the complete result. */
export function VirtualSearchRows({ groups, all, collapsed, listRef, selectedKey, onToggle, onOpen, onPreview }: {
  groups: ResultFileGroup[]; all: boolean; collapsed: string[]; listRef: RefObject<HTMLDivElement>;
  selectedKey?: string; onToggle: (key: string) => void;
  onOpen: (group: ResultFileGroup, hit: ResultHit) => void;
  onPreview?: (group: ResultFileGroup, hit: ResultHit) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const rows = useMemo(() => {
    const folded = new Set(collapsed), out: Row[] = [];
    let top = 0, project: string | undefined;
    const add = (row: Omit<Row, "top">) => { out.push({ ...row, top }); top += row.height; };
    for (const group of groups) {
      if (all && project !== group.projectRoot) {
        project = group.projectRoot;
        add({ key: `project:${project}`, group, project: true, height: 32 });
      }
      add({ key: `file:${group.key}`, group, height: 36 });
      if (!folded.has(group.key)) for (const hit of group.hits) add({ key: resultHitKey(group, hit), group, hit, height: 48 });
    }
    return out;
  }, [groups, all, collapsed]);
  useLayoutEffect(() => {
    const list = listRef.current, node = host.current;
    if (!list || !node) return;
    const update = () => setViewport({ top: Math.max(0, list.scrollTop - node.offsetTop + list.offsetTop), height: list.clientHeight || 600 });
    update(); list.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(list);
    return () => { list.removeEventListener("scroll", update); observer?.disconnect(); };
  }, [listRef, rows]);
  useLayoutEffect(() => {
    const row = rows.find(r => r.hit && r.key === selectedKey), list = listRef.current, node = host.current;
    if (!row || !list || !node) return;
    const top = row.top + node.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.height > list.scrollTop + (list.clientHeight || 600)) list.scrollTop = top + row.height - (list.clientHeight || 600);
    setViewport({ top: Math.max(0, list.scrollTop - node.offsetTop + list.offsetTop), height: list.clientHeight || 600 });
  }, [selectedKey, rows, listRef]);
  // Binary search avoids scanning every hit on each scroll event.
  const lower = (position: number) => {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].top + rows[mid].height <= position) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const start = lower(Math.max(0, viewport.top - 240)), end = Math.min(rows.length, lower(viewport.top + viewport.height + 240) + 1);
  const last = rows[rows.length - 1];
  return <div ref={host} style={{ position: "relative", height: last ? last.top + last.height : 0 }}>
    {rows.slice(start, end).map(row => <div key={row.key} style={{ position: "absolute", top: row.top, height: row.height, left: 0, right: 0, overflow: "hidden" }}>
      {row.project ? <div className="sr-project px-3 py-1 text-[12px] font-semibold">{row.group.project}</div> :
        <ResultFile group={row.group} row={row.hit ?? "header"} collapsed={collapsed.includes(row.group.key)} selectedKey={selectedKey} onToggle={() => onToggle(row.group.key)} onOpen={hit => onOpen(row.group, hit)} onPreview={onPreview ? hit => onPreview(row.group, hit) : undefined} />}
    </div>)}
  </div>;
}
