import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BmfEntry } from "../../lib/bmf";
import { normalizeBmfPath } from "../../lib/bmfPath";
import { Icon } from "../ui/icon";

type Row = { kind: "group"; key: string; count: number; top: number; height: number } | { kind: "entry"; entry: BmfEntry; top: number; height: number };

/** 来源树用可见区渲染；折叠隐藏成员而不销毁当前文档的选中状态。 */
export function MetaResourceList({ entries, selected, search, locked, onSelect }: {
  entries: BmfEntry[]; selected: string | null; search: string; locked: boolean; onSelect: (entry: BmfEntry) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewport, setViewport] = useState({ top: 0, height: 500 });
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const groups = new Map<string, BmfEntry[]>();
    for (const entry of entries) {
      if (query && ![entry.name, entry.displayName, entry.module].some((v) => v.toLowerCase().includes(query))) continue;
      const key = `${entry.origin}/${entry.module || "(未知模块)"}`;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    const result: Row[] = [];
    let top = 0;
    for (const [key, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      result.push({ kind: "group", key, count: members.length, top, height: 28 });
      top += 28;
      if (!query && collapsed.has(key)) continue;
      for (const entry of members.sort((a, b) => a.name.localeCompare(b.name))) {
        result.push({ kind: "entry", entry, top, height: 44 });
        top += 44;
      }
    }
    return result;
  }, [entries, search, collapsed]);
  const total = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTop = Math.min(node.scrollTop, Math.max(0, total - node.clientHeight));
    const measure = () => setViewport({ top: node.scrollTop, height: node.clientHeight || 500 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [total]);
  useLayoutEffect(() => {
    const row = rows.find((r) => r.kind === "entry" && selected && normalizeBmfPath(r.entry.path) === normalizeBmfPath(selected));
    const node = ref.current;
    if (!node || !row) return;
    if (row.top < node.scrollTop || row.top + row.height > node.scrollTop + (node.clientHeight || 500)) {
      node.scrollTop = Math.max(0, row.top - 40);
      setViewport((v) => ({ ...v, top: node.scrollTop }));
    }
  }, [selected, rows]);
  const visible = rows.filter((r) => r.top + r.height >= viewport.top - 88 && r.top <= viewport.top + viewport.height + 88);
  return <div className="meta-tree" ref={ref} onScroll={(e) => { const top = e.currentTarget.scrollTop; setViewport((v) => ({ ...v, top })); }}>
    {!rows.length && <p className="meta-tree-empty">{entries.length ? "没有匹配的组件" : "工作区里没有找到 .bmf 文件"}</p>}
    <div className="meta-resource-rows" style={{ height: total }}>
      {visible.map((row) => row.kind === "group" ? <button type="button" key={row.key} className="meta-group-head" style={{ top: row.top, height: row.height }} title={row.key}
        aria-expanded={!!search.trim() || !collapsed.has(row.key)} disabled={!!search.trim() || locked}
        onClick={() => setCollapsed((prev) => { const next = new Set(prev); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next; })}>
        <Icon name={collapsed.has(row.key) && !search.trim() ? "chevronRight" : "chevronDown"} size={12} /><span>{row.key}</span><span>{row.count}</span>
      </button> : <button type="button" key={row.entry.path} style={{ top: row.top, height: row.height }} disabled={locked}
        className={`meta-entry ${selected && normalizeBmfPath(selected) === normalizeBmfPath(row.entry.path) ? "is-active" : ""} ${row.entry.error ? "is-broken" : ""}`}
        aria-current={selected && normalizeBmfPath(selected) === normalizeBmfPath(row.entry.path) ? "true" : undefined}
        onClick={() => onSelect(row.entry)} title={row.entry.error ? `${row.entry.path}\n${row.entry.error}` : row.entry.path}>
        <span className="meta-entry-name">{row.entry.displayName || row.entry.name || "(无名)"}</span>
        <span className="meta-entry-sub">{row.entry.name}{row.entry.error ? " · 解析失败" : ` · ${row.entry.entityCount} 实体 / ${row.entry.attrCount} 字段`}</span>
      </button>)}
    </div>
  </div>;
}
