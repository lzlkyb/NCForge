import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BmfDetail, BmfEditOp, BmfEntity } from "../../lib/bmf";
import { BMF_BASE_TYPES, baseTypeById, fieldTypeOps } from "../../lib/bmfTypes";
import type { MetaStage } from "../../lib/metaDraft";
import { fieldWindow } from "../../lib/metaEditor";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";

type CellColumn = "displayName" | "fieldName" | "length" | "type";
export function MetaFieldTable({ entity, selectedAttrId, filter, scroll, locked, onFilter, onSelect, onInspect, onEdit, onAdd, onScroll,
  selectedIds = [], onSelectedIds, onBulk, detail, onStage, onEditingChange }: {
  entity: BmfEntity; selectedAttrId: string | null; filter: string; scroll: { left: number; top: number }; locked: boolean;
  onFilter: (filter: string) => void; onSelect: (attrId: string) => void;
  onInspect: () => void; onEdit: (attrId: string) => void; onAdd: () => void;
  onScroll: (scroll: { left: number; top: number }) => void;
  selectedIds?: string[]; onSelectedIds?: (ids: string[]) => void; detail?: BmfDetail; onStage?: MetaStage;
  onBulk?: (kind: "paste" | "batch" | "template", ids: string[], text?: string) => void; onEditingChange?: (editing: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const initial = useRef(scroll);
  initial.current = scroll;
  const [viewport, setViewport] = useState({ top: scroll.top, height: 240 });
  const [cell, setCell] = useState<{ id: string; column: CellColumn; value: string; busy: boolean; error: string | null } | null>(null);
  const editingCallback = useRef(onEditingChange); editingCallback.current = onEditingChange;
  const editing = !!cell;
  useEffect(() => { editingCallback.current?.(editing); return () => editingCallback.current?.(false); }, [editing]);
  const selected = useMemo(() => { const valid = new Set(entity.attrs.map((a) => a.id)); return new Set(selectedIds.filter((id) => valid.has(id))); }, [selectedIds, entity.attrs]);
  const anchor = useRef<string | null>(null);
  const attrs = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? entity.attrs.filter((a) => [a.name, a.displayName, a.field, a.typeName].some((v) => v.toLowerCase().includes(query))) : entity.attrs;
  }, [entity.attrs, filter]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTop = initial.current.top;
    node.scrollLeft = initial.current.left;
    const measure = () => setViewport({ top: node.scrollTop, height: node.clientHeight || 240 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [entity.id, filter]);
  const range = fieldWindow(attrs.length, viewport.top, viewport.height);
  const selectedIndex = attrs.findIndex((a) => a.id === selectedAttrId);
  const selectionRef = useRef({ attrId: selectedAttrId, filter });
  useLayoutEffect(() => {
    const previous = selectionRef.current;
    selectionRef.current = { attrId: selectedAttrId, filter };
    // 清除筛选也需要定位；文档初次挂载仍保留用户上次的滚动位置。
    if (previous.attrId === selectedAttrId && !(previous.filter && !filter)) return;
    const node = ref.current;
    if (!node || selectedIndex < 0) return;
    const top = selectedIndex * 32;
    if (top < node.scrollTop || top + 64 > node.scrollTop + node.clientHeight) {
      node.scrollTop = Math.max(0, top - Math.max(0, node.clientHeight - 64) / 2);
      setViewport((v) => ({ ...v, top: node.scrollTop }));
      onScroll({ left: node.scrollLeft, top: node.scrollTop });
    }
  }, [selectedAttrId, selectedIndex, filter, onScroll]);
  const moveSelection = (index: number) => {
    if (!attrs.length) return;
    const next = Math.max(0, Math.min(attrs.length - 1, index));
    onSelect(attrs[next].id);
    ref.current?.focus({ preventScroll: true });
  };
  const choose = (id: string, toggle = false, range = false) => {
    if (locked || cell) return;
    const next = new Set(toggle ? selected : []);
    if (range && anchor.current) {
      const from = attrs.findIndex((a) => a.id === anchor.current), to = attrs.findIndex((a) => a.id === id);
      attrs.slice(Math.min(Math.max(0, from), to), Math.max(from, to) + 1).forEach((a) => next.add(a.id));
    } else if (toggle && next.has(id)) next.delete(id); else next.add(id);
    if (!range) anchor.current = id;
    onSelect(id); onSelectedIds?.([...next]);
  };
  const editCell = (id: string, column: CellColumn = "displayName") => {
    if (locked || cell) return;
    if (!onStage || !detail) { onEdit(id); return; }
    const attr = entity.attrs.find((a) => a.id === id); if (!attr) return;
    onSelect(id);
    setCell({ id, column, value: column === "type" ? attr.dataType : column === "fieldName" ? attr.field : column === "length" ? String(attr.length ?? "") : attr.displayName, busy: false, error: null });
  };
  const applyCell = async () => {
    if (!cell || cell.busy || !onStage || !detail) return;
    const field = entity.attrs.find((a) => a.id === cell.id); if (!field) { setCell(null); return; }
    setCell({ ...cell, busy: true, error: null });
    try {
      let ops: BmfEditOp[];
      if (cell.column === "type") {
        ops = fieldTypeOps(detail, field, cell.value);
        const type = baseTypeById(cell.value)!;
        if (ops.length) ops.push(...[["length", type.length], ["precision", type.precision]].map(([name, value]) => ({ op: "setAttr" as const, id: field.id, name: String(name), value: value == null ? "" : String(value) })));
      } else {
        const value = cell.column === "displayName" ? cell.value : cell.value.trim();
        if (cell.column === "fieldName" && value !== field.field && !/^[a-z][a-z0-9_]*$/.test(value)) throw new Error("列名须以小写字母开头，只含字母、数字、下划线");
        if (cell.column === "length" && value && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 0xffffffff)) throw new Error("长度必须是正整数");
        ops = [{ op: "setAttr", id: field.id, name: cell.column, value }];
      }
      if (!await onStage(`快速编辑 ${field.name}`, ops)) throw new Error("草稿未接收修改，请重试");
      setCell(null); ref.current?.focus({ preventScroll: true });
    } catch (error) { setCell({ ...cell, busy: false, error: (error as Error).message }); }
  };
  const editable = (id: string, column: CellColumn, content: React.ReactNode) => cell?.id === id && cell.column === column
    ? <div className="meta-cell-edit" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!cell.busy) setCell(null); }
      if (e.key === "Enter" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s")) { e.preventDefault(); e.stopPropagation(); void applyCell(); }
    }}>{column === "type" ? <select autoFocus aria-label="快速编辑类型" value={cell.value} disabled={cell.busy} onChange={(e) => setCell({ ...cell, value: e.target.value, error: null })}>
      {!baseTypeById(cell.value) && <option value={cell.value}>保留原类型</option>}{BMF_BASE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
      : <Input autoFocus aria-label={`快速编辑${column === "displayName" ? "显示名" : column === "fieldName" ? "列名" : "长度"}`} value={cell.value} disabled={cell.busy}
        onChange={(e) => setCell({ ...cell, value: e.target.value, error: null })} />}
      <button type="button" className="meta-link" disabled={cell.busy} aria-label="应用单元格修改" onClick={() => void applyCell()}>应用</button></div>
    : <span className="meta-cell-value" onDoubleClick={(e) => { e.stopPropagation(); editCell(id, column); }}>{content}</span>;
  return <div className="meta-fields">
    <div className="meta-fields-head">
      <div className="meta-fields-identity"><strong>{entity.displayName || entity.name}</strong><span>{entity.table || "无表名"} · {attrs.length}/{entity.attrs.length} 字段</span></div>
      <div className="meta-attr-search"><Icon name="search" size={13} /><Input value={filter} disabled={locked} onChange={(e) => onFilter(e.target.value)} placeholder="过滤字段" aria-label="过滤字段" /></div>
      <button type="button" className="meta-link" disabled={locked} onClick={onAdd}><Icon name="plus" size={13} />加字段</button>
    </div>
    {onBulk && <div className="meta-bulk-toolbar"><span>{selected.size ? `已选 ${selected.size} 字段` : "勾选字段进行批量操作"}</span>
      <button type="button" className="meta-link" disabled={locked || !selected.size} onClick={() => onBulk("batch", [...selected])}>批量设置</button>
      <button type="button" className="meta-link" disabled={locked} onClick={() => onBulk("paste", [])}>粘贴字段</button>
      <button type="button" className="meta-link" disabled={locked} onClick={() => onBulk("template", [])}>字段模板</button></div>}
    {cell?.error && <div className="meta-filter-note meta-draft-error" role="alert">{cell.error}</div>}
    {cell && <div className="meta-bulk-toolbar"><span>正在快速编辑 {entity.attrs.find((a) => a.id === cell.id)?.name}</span><button type="button" className="meta-link" disabled={cell.busy} onClick={() => setCell(null)}>取消快改</button></div>}
    {selectedAttrId && selectedIndex < 0 && <div className="meta-filter-note" role="status">当前字段不在筛选结果中。
      <button type="button" className="meta-link" disabled={locked} onClick={() => onFilter("")}>清除筛选并定位</button></div>}
    <div className="meta-field-scroll" ref={ref} tabIndex={0} role="region" aria-label={`${entity.name} 字段表`} onScroll={(e) => {
      const node = e.currentTarget;
      setViewport((v) => ({ ...v, top: node.scrollTop }));
      onScroll({ left: node.scrollLeft, top: node.scrollTop });
    }} onPaste={(e) => { if (onBulk && !locked && !cell && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); onBulk("paste", [], e.clipboardData.getData("text/plain")); } }} onKeyDown={(e) => {
      if (locked || cell || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && onSelectedIds) { e.preventDefault(); onSelectedIds(attrs.map((a) => a.id)); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        moveSelection(e.key === "Home" ? 0 : e.key === "End" ? attrs.length - 1 : selectedIndex + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter") { e.preventDefault(); onInspect(); }
      else if (e.key === "F2" && selectedAttrId) { e.preventDefault(); editCell(selectedAttrId); }
    }}>
      <table className={`meta-field-table ${onSelectedIds ? "has-selection" : ""}`} aria-label="实体字段" aria-rowcount={attrs.length + 1}>
        <thead><tr>{onSelectedIds && <th scope="col" className="meta-field-check"><input type="checkbox" aria-label="选择筛选后的全部字段" disabled={locked} checked={attrs.length > 0 && attrs.every((a) => selected.has(a.id))}
          onChange={(e) => onSelectedIds(e.target.checked ? attrs.map((a) => a.id) : selectedIds.filter((id) => !attrs.some((a) => a.id === id)))} /></th>}{["字段", "显示名", "类型", "列名", "长度", "约束"].map((title) => <th key={title} scope="col">{title}</th>)}</tr></thead>
        <tbody>
          {range.before > 0 && <tr aria-hidden="true" className="meta-field-spacer"><td colSpan={onSelectedIds ? 7 : 6} style={{ height: range.before }} /></tr>}
          {attrs.slice(range.start, range.end).map((attr, offset) => <tr key={attr.id} data-attr={attr.id} aria-rowindex={range.start + offset + 2}
            aria-selected={selectedAttrId === attr.id || selected.has(attr.id)} className={selectedAttrId === attr.id ? "is-active" : selected.has(attr.id) ? "is-selected" : ""}
            tabIndex={locked ? -1 : selectedAttrId === attr.id || (!selectedAttrId && offset === 0) ? 0 : -1}
            onClick={(e) => choose(attr.id, e.ctrlKey || e.metaKey, e.shiftKey)} onDoubleClick={() => editCell(attr.id)}>
            {onSelectedIds && <td className="meta-field-check"><input type="checkbox" checked={selected.has(attr.id)} disabled={locked} aria-label={`选择字段 ${attr.name}`} onClick={(e) => e.stopPropagation()} onChange={() => choose(attr.id, true)} /></td>}
            <td className="meta-mono" title={attr.name}>{attr.isKey && <Icon name="key" size={11} />}{attr.name}</td>
            <td title={attr.displayName}>{editable(attr.id, "displayName", attr.displayName || "—")}</td>
            <td title={attr.typeName}>{editable(attr.id, "type", attr.typeName || attr.dataType || "—")}</td>
            <td className="meta-mono" title={attr.field}>{editable(attr.id, "fieldName", attr.field || "—")}</td>
            <td className="meta-mono">{editable(attr.id, "length", attr.length ?? "—")}</td>
            <td><span className="meta-constraints">{attr.isKey && <span className="meta-tag meta-tag-key">PK</span>}
              <span className={`meta-tag ${attr.nullable ? "" : "meta-tag-strong"}`}>{attr.nullable ? "空" : "非空"}</span>
              {attr.style === "ARRAY" && <span className="meta-tag meta-tag-array">ARRAY</span>}</span></td>
          </tr>)}
          {range.after > 0 && <tr aria-hidden="true" className="meta-field-spacer"><td colSpan={onSelectedIds ? 7 : 6} style={{ height: range.after }} /></tr>}
        </tbody>
      </table>
      {attrs.length === 0 && <p className="meta-note meta-fields-empty">{entity.attrs.length ? "没有匹配字段，试试更短的名称。" : "实体还没有字段，点击「加字段」开始。"}</p>}
    </div>
    <div className="meta-fields-foot"><span>{cell ? "Enter 应用 · Esc 取消" : "方向键选择 · Enter 属性 · F2 编辑"}</span><span>{selectedAttrId ? entity.attrs.find((a) => a.id === selectedAttrId)?.name : "请选择一个字段"}</span></div>
  </div>;
}
