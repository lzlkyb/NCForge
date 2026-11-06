import { useEffect, useMemo, useRef, useState } from "react";
import type { BmfArtifact, BmfArtifactStatus, BmfGenPlan } from "../../lib/bmf";
import type { GenerationPreferences, GenerationFilter } from "../../lib/bmfGeneration";
import { filteredGeneration, GENERATION_FAMILIES, GENERATION_STATUSES } from "../../lib/metaGeneration";
import { Icon } from "../ui/icon";

interface Props {
  plan: BmfGenPlan; statuses: Record<string, BmfArtifactStatus>; prefs: GenerationPreferences; disabled: boolean;
  onPreferences: (prefs: Partial<GenerationPreferences>, render?: boolean) => void; onOpenOld: (path: string) => void;
}
type Row = { kind: "group"; family: string; items: BmfArtifact[] } | { kind: "file"; item: BmfArtifact } | { kind: "old"; item: BmfArtifactStatus };
const ROW_HEIGHT = 52;

export function GenArtifacts({ plan, statuses, prefs, disabled, onPreferences, onOpenOld }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const initialTop = useRef(prefs.listTop);
  const [window, setWindow] = useState({ top: prefs.listTop, height: 400 });
  const selected = useMemo(() => new Set(prefs.selected ?? []), [prefs.selected]);
  const rows = useMemo(() => {
    const filtered = filteredGeneration(plan.artifacts, statuses, prefs.search, prefs.filter);
    const groups = new Map<string, BmfArtifact[]>();
    for (const a of filtered) { const group = groups.get(a.family); if (group) group.push(a); else groups.set(a.family, [a]); }
    const out: Row[] = [];
    for (const [family, items] of groups) {
      out.push({ kind: "group", family, items });
      if (!prefs.collapsed.includes(family)) out.push(...items.map((item): Row => ({ kind: "file", item })));
    }
    if (prefs.filter === "all") {
      const old = Object.values(statuses).filter((s) => s.status === "orphan" && (!prefs.search || s.path.toLowerCase().includes(prefs.search.toLowerCase())));
      if (old.length) { out.push({ kind: "group", family: "orphan", items: [] }); if (!prefs.collapsed.includes("orphan")) out.push(...old.map((item): Row => ({ kind: "old", item }))); }
    }
    return out;
  }, [plan, statuses, prefs.search, prefs.filter, prefs.collapsed]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    element.scrollTop = initialTop.current;
    const observer = new ResizeObserver(() => setWindow((s) => ({ ...s, height: element.clientHeight })));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const toggle = (ids: string[]) => {
    const next = new Set(selected);
    const remove = ids.every((id) => next.has(id));
    ids.forEach((id) => { if (remove) next.delete(id); else next.add(id); });
    onPreferences({ selected: [...next], overrides: prefs.overrides.filter((id) => next.has(id)) });
  };
  const focusNext = (id: string, direction: number) => {
    const files = rows.filter((r): r is Extract<Row, { kind: "file" }> => r.kind === "file");
    const index = files.findIndex((r) => r.item.id === id);
    const next = files[Math.max(0, Math.min(files.length - 1, index + direction))];
    if (!next || !host.current) return;
    const top = rows.indexOf(next) * ROW_HEIGHT;
    if (top < host.current.scrollTop || top + ROW_HEIGHT > host.current.scrollTop + host.current.clientHeight) host.current.scrollTop = top;
    setWindow((s) => ({ ...s, top: host.current?.scrollTop ?? top }));
    onPreferences({ activeId: next.item.id });
    requestAnimationFrame(() => [...(host.current?.querySelectorAll<HTMLButtonElement>("[data-file-id]") ?? [])].find((button) => button.dataset.fileId === next.item.id)?.focus());
  };
  const visible = Math.ceil(Math.max(window.height, 120) / ROW_HEIGHT) + 6;
  const start = Math.min(Math.max(0, rows.length - visible), Math.max(0, Math.floor(window.top / ROW_HEIGHT) - 3));
  const end = Math.min(rows.length, start + visible);
  return <aside className="gen-files" aria-label="生成产物">
    <div className="gen-files-head"><strong>生成产物</strong><span>{selected.size} / {plan.artifacts.length}</span>
      <button type="button" disabled={disabled} onClick={() => onPreferences({ selected: selected.size === plan.artifacts.length ? [] : plan.artifacts.map((a) => a.id), overrides: [] })}>{selected.size === plan.artifacts.length ? "全不选" : "全选"}</button></div>
    <div className="gen-file-search"><Icon name="search" size={14} /><input aria-label="搜索生成产物" value={prefs.search} placeholder="搜索文件名或路径" disabled={disabled} onChange={(e) => { onPreferences({ search: e.target.value, listTop: 0 }); if (host.current) host.current.scrollTop = 0; setWindow((s) => ({ ...s, top: 0 })); }} /></div>
    <div className="gen-filters" role="group" aria-label="产物状态筛选">{([['all', '全部'], ['pending', '待写入'], ['protected', '手改 / 冲突']] as [GenerationFilter, string][]).map(([filter, label]) =>
      <button type="button" key={filter} disabled={disabled} aria-pressed={filter === prefs.filter} onClick={() => { onPreferences({ filter, listTop: 0 }); if (host.current) host.current.scrollTop = 0; setWindow((s) => ({ ...s, top: 0 })); }}>{label}</button>)}</div>
    <div className="gen-file-scroll" ref={host} onScroll={(e) => { const top = e.currentTarget.scrollTop; setWindow((s) => ({ ...s, top })); onPreferences({ listTop: top }, false); }}>
      {!rows.length && <p className="gen-empty">{plan.artifacts.length ? "没有匹配的产物，调整搜索或筛选" : "当前模型没有可生成的产物"}</p>}
      <div style={{ height: start * ROW_HEIGHT }} aria-hidden="true" />
      {rows.slice(start, end).map((row) => row.kind === "group" ? <div className="gen-file-group" key={`group:${row.family}`}>
        <button type="button" disabled={disabled} aria-expanded={!prefs.collapsed.includes(row.family)} aria-label={`${prefs.collapsed.includes(row.family) ? "展开" : "收起"}${GENERATION_FAMILIES[row.family] ?? row.family}`} onClick={() => onPreferences({ collapsed: prefs.collapsed.includes(row.family) ? prefs.collapsed.filter((f) => f !== row.family) : [...prefs.collapsed, row.family] })}><Icon name="chevronRight" size={13} className={!prefs.collapsed.includes(row.family) ? "gen-expanded" : ""} /></button>
        {row.items.length > 0 && <input type="checkbox" disabled={disabled} aria-label={`选择${GENERATION_FAMILIES[row.family]}当前筛选项`} checked={row.items.every((a) => selected.has(a.id))} ref={(input) => { if (input) input.indeterminate = row.items.some((a) => selected.has(a.id)) && !row.items.every((a) => selected.has(a.id)); }} onChange={() => toggle(row.items.map((a) => a.id))} />}
        <strong>{GENERATION_FAMILIES[row.family] ?? row.family}</strong><small>{row.items.length || "保留"}</small>
      </div> : row.kind === "old" ? <div key={row.item.id} className="gen-file gen-old-file"><button type="button" disabled={disabled} onClick={() => onOpenOld(row.item.path)} title={row.item.path}><span>{row.item.path.split(/[\\/]/).pop()}</span><small>{row.item.path}</small></button><span className="gen-file-status">保留</span></div> : <div key={row.item.id} className={`gen-file${row.item.id === prefs.activeId ? " is-active" : ""}`}>
        <input type="checkbox" disabled={disabled} aria-label={`选择 ${row.item.name}`} checked={selected.has(row.item.id)} onChange={() => toggle([row.item.id])} />
        <button type="button" data-file-id={row.item.id} disabled={disabled} aria-pressed={row.item.id === prefs.activeId} title={row.item.pathHint} onClick={() => onPreferences({ activeId: row.item.id })}
          onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); focusNext(row.item.id, e.key === "ArrowDown" ? 1 : -1); } else if (e.key === " ") { e.preventDefault(); toggle([row.item.id]); } }}><span>{row.item.name}</span><small>{row.item.pathHint}</small></button>
        <span className={`gen-file-status is-${statuses[row.item.id]?.status ?? "unknown"}`} title={statuses[row.item.id]?.detail}>{GENERATION_STATUSES[statuses[row.item.id]?.status ?? ""] ?? "待检查"}</span>
      </div>)}
      <div style={{ height: (rows.length - end) * ROW_HEIGHT }} aria-hidden="true" />
    </div>
    <small className="gen-files-foot">勾选控制写入范围 · 手改文件默认保留</small>
  </aside>;
}
