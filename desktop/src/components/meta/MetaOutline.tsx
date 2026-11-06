import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BmfDetail } from "../../lib/bmf";
import { fieldWindow, type MetaSelection } from "../../lib/metaEditor";
import { Icon, type IconName } from "../ui/icon";

interface OutlineRow { key: string; label: string; title: string; icon: IconName; selection: MetaSelection; nested?: boolean }
const selectionKey = (selection: MetaSelection) => JSON.stringify(selection);

/** 大纲只挂载可见行；展开当前实体/接口的属性也不会挂载整份大模型。 */
export function MetaOutline({ detail, selection, locked, onSelect }: {
  detail: BmfDetail; selection: MetaSelection; locked: boolean; onSelect: (selection: MetaSelection) => void;
}) {
  const [open, setOpen] = useState(true);
  const [viewport, setViewport] = useState({ top: 0, height: 180 });
  const ref = useRef<HTMLDivElement>(null);
  const selectedEntity = selection.kind === "entity" || selection.kind === "attr" ? selection.entityId : null;
  const selectedInterface = selection.kind === "interface" || selection.kind === "interfaceAttr" ? selection.interfaceId : null;
  const rows = useMemo(() => {
    const result: OutlineRow[] = [];
    const add = (selection: MetaSelection, label: string, icon: IconName, title = label, nested = false) => result.push({ key: selectionKey(selection), selection, label, icon, title, nested });
    add({ kind: "component" }, detail.component.displayName || detail.component.name, "metaFile");
    for (const entity of detail.entities) {
      add({ kind: "entity", entityId: entity.id }, entity.displayName || entity.name, "layers", `${entity.fullClass} · ${entity.attrs.length} 字段`);
      if (entity.id === selectedEntity) for (const attr of entity.attrs) add({ kind: "attr", entityId: entity.id, attrId: attr.id }, attr.displayName || attr.name, "symbolField", `${attr.name} · ${attr.typeName}`, true);
    }
    for (const itf of detail.interfaces ?? []) {
      add({ kind: "interface", interfaceId: itf.id }, itf.displayName || itf.name, "code", `${itf.fullClass} · ${itf.external ? "外部定义只读" : "业务接口"}`);
      if (itf.id === selectedInterface) for (const attr of itf.attrs) add({ kind: "interfaceAttr", interfaceId: itf.id, attrId: attr.id }, attr.displayName || attr.name, "symbolField", `${attr.name} · ${attr.typeName}`, true);
    }
    for (const en of detail.enums) add({ kind: "enum", enumId: en.id }, en.displayName || en.name, "javaEnum");
    for (const relation of detail.relations) add({ kind: "relation", relationId: relation.id }, relation.displayName || relation.name || relation.kind, "arrowRight", relation.kind);
    for (const reference of detail.references ?? []) add({ kind: "reference", referenceId: reference.id }, reference.displayName || reference.name || reference.id, "arrowRight", `${reference.metadataPath} · 参照只读`);
    return result;
  }, [detail, selectedEntity, selectedInterface]);
  const selectedIndex = rows.findIndex((row) => row.key === selectionKey(selection));
  useLayoutEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    const measure = () => setViewport({ top: node.scrollTop, height: node.clientHeight || 180 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [open]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!open || !node || selectedIndex < 0) return;
    const top = selectedIndex * 28;
    if (top < node.scrollTop || top + 28 > node.scrollTop + (node.clientHeight || 180)) {
      node.scrollTop = Math.max(0, top - 56); setViewport((v) => ({ ...v, top: node.scrollTop }));
    }
  }, [open, selectedIndex, rows]);
  const range = fieldWindow(rows.length, viewport.top, viewport.height, 28);
  return <section className="meta-outline"><button type="button" className="meta-outline-head" aria-expanded={open} onClick={() => setOpen(!open)}>
    <Icon name={open ? "chevronDown" : "chevronRight"} size={12} /><strong>模型大纲</strong><span>{rows.length} 对象</span>
  </button>{open && <div className="meta-outline-scroll" ref={ref} tabIndex={0} role="region" aria-label="模型对象大纲"
    onScroll={(e) => { const top = e.currentTarget.scrollTop; setViewport((v) => ({ ...v, top })); }} onKeyDown={(e) => {
      if (locked || !["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const index = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, selectedIndex + (e.key === "ArrowDown" ? 1 : -1)));
      if (rows[index]) { onSelect(rows[index].selection); ref.current?.focus({ preventScroll: true }); }
    }}>
    <div style={{ height: rows.length * 28, position: "relative" }}>{rows.slice(range.start, range.end).map((row, offset) => <button type="button" key={row.key} disabled={locked}
      className={`meta-outline-row ${row.key === selectionKey(selection) ? "is-active" : ""}`} aria-pressed={row.key === selectionKey(selection)}
      style={{ position: "absolute", top: (range.start + offset) * 28, height: 28, paddingLeft: row.nested ? 24 : 8 }}
      onClick={() => onSelect(row.selection)} title={row.title}><Icon name={row.icon} size={12} /><span>{row.label}</span>
    </button>)}</div>
  </div>}</section>;
}
