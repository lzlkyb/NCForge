import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BmfDetail, BmfEntity, BmfInterfaceAttr, BmfInterfaceMapping } from "../../lib/bmf";
import { mappingCompatible } from "../../lib/bmfTypes";
import { fieldWindow, type MetaSelection } from "../../lib/metaEditor";
import type { MetaStage } from "../../lib/metaDraft";
import { MetaOpDialog } from "./MetaOpDialog";

type MappingRow = { entity: BmfEntity; expected: BmfInterfaceAttr; bindings: BmfInterfaceMapping[] };
type MappingEdit = { entityId: string; interfaceId: string; attrId: string; target: string };

const pathMapping = (bindings: BmfInterfaceMapping[]) => bindings.some((m) => !!m.attrPath || !!m.attrPathId);
const wrongOwner = (row: MappingRow) => row.bindings.some((m) => !!m.entityId && m.entityId !== row.entity.id);
function mappingStatus(detail: BmfDetail, row: MappingRow) {
  if (pathMapping(row.bindings)) return "路径映射 · 只读";
  if (wrongOwner(row)) return "所属实体不一致 · 只读";
  if (!row.bindings.length) return "未绑定";
  if (row.bindings.length > 1) return "重复映射 · 先解除";
  const field = row.entity.attrs.find((a) => a.id === row.bindings[0].attrId);
  return !field ? "目标字段不存在" : mappingCompatible(detail, field, row.expected) ? "已绑定" : "类型不匹配";
}

/** 映射只改当前实体的直连字段；外部定义、未解析属性与跨路径映射保留原文。 */
export function MetaSemanticPanel({ detail, selection, onSelect, onStage, onEdited, onReload, locked, onEditingChange, onOpenRefs }: {
  detail: BmfDetail; selection: MetaSelection; onSelect: (selection: MetaSelection) => void;
  onStage?: MetaStage; onEdited: () => void; onReload?: () => void; locked: boolean;
  onEditingChange?: (editing: boolean) => void; onOpenRefs?: (path: string) => void;
}) {
  const [edit, setEdit] = useState<MappingEdit | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 240 });
  const table = useRef<HTMLDivElement>(null);
  const editingCallback = useRef(onEditingChange);
  editingCallback.current = onEditingChange;
  useEffect(() => { editingCallback.current?.(!!edit); return () => editingCallback.current?.(false); }, [edit]);
  const interfaces = detail.interfaces ?? [];
  const selectedId = selection.kind === "interface" || selection.kind === "interfaceAttr" ? selection.interfaceId
    : selection.kind === "attr" ? detail.entities.find((e) => e.id === selection.entityId)?.mappings?.find((m) => m.attrId === selection.attrId)?.interfaceId : null;
  const active = interfaces.find((i) => i.id === selectedId) ?? interfaces[0];
  const owners = useMemo(() => active ? detail.entities
    .filter((e) => e.interfaceIds?.includes(active.id) || e.mappings?.some((m) => m.interfaceId === active.id)) : [], [active, detail.entities]);
  const rowCount = owners.length * (active?.attrs.length ?? 0);
  useLayoutEffect(() => {
    const node = table.current;
    if (!node) return;
    node.scrollTop = 0;
    const measure = () => setViewport({ top: node.scrollTop, height: node.clientHeight || 240 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [active?.id, rowCount]);
  useLayoutEffect(() => {
    if (selection.kind !== "interfaceAttr" || !active || !owners.length) return;
    const index = active.attrs.findIndex((a) => a.id === selection.attrId), node = table.current;
    if (!node || index < 0) return;
    const top = index * 32;
    if (top < node.scrollTop || top + 64 > node.scrollTop + (node.clientHeight || 240)) {
      node.scrollTop = Math.max(0, top - 64); setViewport((v) => ({ ...v, top: node.scrollTop }));
    }
  }, [selection, active, owners.length]);
  const range = fieldWindow(rowCount, viewport.top, viewport.height);
  // 按可见索引取实体与接口属性，避免先构造大模型的笛卡尔积再截取。
  const rows: MappingRow[] = active ? Array.from({ length: range.end - range.start }, (_, offset) => {
    const index = range.start + offset, entity = owners[Math.floor(index / active.attrs.length)], expected = active.attrs[index % active.attrs.length];
    return { entity, expected, bindings: (entity.mappings ?? []).filter((m) => m.interfaceId === active.id && m.interfaceAttrId === expected.id) };
  }) : [];
  const lockedNow = locked || !!edit;
  const unresolved = detail.entities.flatMap((entity) => [...new Set([...(entity.interfaceIds ?? []), ...(entity.mappings ?? []).map((m) => m.interfaceId)])]
    .filter((id) => !interfaces.some((i) => i.id === id)).map((id) => ({ entity, id })));
  const knownAttrs = new Set(active?.attrs.map((a) => a.id));
  const orphaned = active ? detail.entities.flatMap((entity) => (entity.mappings ?? [])
    .filter((m) => m.interfaceId === active.id && !knownAttrs.has(m.interfaceAttrId)).map((mapping) => ({ entity, mapping }))) : [];
  const editEntity = edit ? detail.entities.find((e) => e.id === edit.entityId) : undefined;
  const editInterface = edit ? interfaces.find((i) => i.id === edit.interfaceId) : undefined;
  const expected = editInterface?.attrs.find((a) => a.id === edit?.attrId);
  const bindings = editEntity?.mappings?.filter((m) => m.interfaceId === edit?.interfaceId && m.interfaceAttrId === edit?.attrId) ?? [];
  const target = editEntity?.attrs.find((a) => a.id === edit?.target);
  const editValid = !!edit && !!editEntity && !!expected && !!editEntity.interfaceIds?.includes(edit.interfaceId)
    && !pathMapping(bindings) && !bindings.some((m) => !!m.entityId && m.entityId !== editEntity.id)
    && (!edit.target || (bindings.length <= 1 && !!target && mappingCompatible(detail, target, expected)));
  const finish = () => { setEdit(null); onEdited(); };
  const reload = () => { setEdit(null); (onReload ?? onEdited)(); };

  return <section className="meta-semantic-panel">
    <div className="meta-section-head"><h4 className="meta-section-title">业务接口与映射</h4>
      <label className="meta-form"><span className="sr-only">当前业务接口</span><select aria-label="当前业务接口" value={active?.id ?? ""} disabled={lockedNow}
        onChange={(e) => onSelect({ kind: "interface", interfaceId: e.target.value })}>
        {!interfaces.length && <option value="">没有已加载接口</option>}{interfaces.map((i) => <option key={i.id} value={i.id}>{i.displayName || i.name} · {i.name}</option>)}
      </select></label>
    </div>
    {active ? <>
      <p className="meta-note"><button type="button" className="meta-link" disabled={lockedNow} onClick={() => onSelect({ kind: "interface", interfaceId: active.id })}>{active.displayName || active.name}</button>
        {` · ${active.attrs.length} 个属性 · ${active.external ? "外部定义只读" : "本组件定义只读"}`}
        {active.external && active.sourcePath && onOpenRefs && <> · <button type="button" className="meta-link" disabled={lockedNow} onClick={() => onOpenRefs(active.sourcePath)}>打开定义</button></>}</p>
      <p className="meta-note">接口定义保留原文。映射可修改兼容的直连字段，点击接口属性或目标字段可双向定位。</p>
      <div className="meta-field-scroll" ref={table} style={{ height: Math.min(320, (rowCount + 1) * 32), maxHeight: 320 }}
        onScroll={(e) => { const top = e.currentTarget.scrollTop; setViewport((v) => ({ ...v, top })); }}>
        <table className="meta-field-table" aria-label="接口字段映射" aria-rowcount={rowCount + 1}>
          <thead><tr>{["接口属性", "类型", "实体", "目标字段", "状态", "操作"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>
            {range.before > 0 && <tr className="meta-field-spacer" aria-hidden="true"><td colSpan={6} style={{ height: range.before }} /></tr>}
            {rows.map((row, offset) => <tr key={`${row.entity.id}/${row.expected.id}`} data-mapping={`${row.entity.id}/${row.expected.id}`}
              aria-rowindex={range.start + offset + 2} className={selection.kind === "interfaceAttr" && selection.interfaceId === active.id && selection.attrId === row.expected.id ? "is-active" : ""}>
              <td title={row.expected.displayName || row.expected.name}><button type="button" className="meta-link" disabled={lockedNow}
                onClick={() => onSelect({ kind: "interfaceAttr", interfaceId: active.id, attrId: row.expected.id })}>{row.expected.name}</button></td>
              <td title={row.expected.typeName || row.expected.dataType}>{row.expected.typeName || row.expected.dataType || "未声明"}</td>
              <td><button type="button" className="meta-link" disabled={lockedNow} onClick={() => onSelect({ kind: "entity", entityId: row.entity.id })}>{row.entity.displayName || row.entity.name}</button></td>
              <td>{row.bindings.length ? row.bindings.map((m, index) => {
                const field = row.entity.attrs.find((a) => a.id === m.attrId);
                return <span key={`${m.attrId}/${index}`}>{index ? "、" : ""}<button type="button" className="meta-link" disabled={lockedNow || !field}
                  onClick={() => { if (field) onSelect({ kind: "attr", entityId: row.entity.id, attrId: field.id }); }}>{field?.name || m.attrId || "未绑定"}</button></span>;
              }) : "—"}</td>
              <td title={mappingStatus(detail, row)}>{mappingStatus(detail, row)}</td>
              <td><button type="button" className="meta-link" aria-label={`修改 ${row.entity.name} 的 ${row.expected.name} 映射`}
                disabled={lockedNow || !onStage || pathMapping(row.bindings) || wrongOwner(row) || !row.entity.interfaceIds?.includes(active.id)}
                onClick={() => setEdit({ entityId: row.entity.id, interfaceId: active.id, attrId: row.expected.id, target: row.bindings.length === 1 ? row.bindings[0].attrId : "" })}>
                {row.bindings.length > 1 ? "解除重复" : "修改"}</button></td>
            </tr>)}
            {range.after > 0 && <tr className="meta-field-spacer" aria-hidden="true"><td colSpan={6} style={{ height: range.after }} /></tr>}
          </tbody></table>
      </div>
      {!rowCount && <p className="meta-note">没有实体实现此接口，可通过「业务接口实现」关系绑定实体。</p>}
      {orphaned.map(({ entity, mapping }, index) => <p className="meta-note" key={`${entity.id}/${index}`}>{entity.displayName || entity.name}：接口属性 {mapping.interfaceAttrId} 未加载，现有映射只读。</p>)}
    </> : <p className="meta-note">这个组件没有已加载的业务接口定义。</p>}
    {unresolved.map(({ entity, id }) => <p className="meta-note" key={`${entity.id}/${id}`}>{entity.displayName || entity.name}：接口 {id} 未加载或存在定义冲突，映射只读。</p>)}
    <div className="meta-section-head"><h4 className="meta-section-title">参照与依赖</h4></div>
    {(detail.references ?? []).map((reference) => {
      const definition = interfaces.find((i) => i.id === reference.refId);
      return <div className="meta-relation" key={reference.id}><button type="button" className="meta-object-link" disabled={lockedNow}
        aria-pressed={selection.kind === "reference" && selection.referenceId === reference.id} onClick={() => onSelect({ kind: "reference", referenceId: reference.id })}>{reference.displayName || reference.name || reference.id}</button>
        <p className="meta-note">{reference.metadataPath || reference.fullClass || reference.refId} · {reference.resolution || "已定位定义"} · 参照定义只读</p>
        {definition?.sourcePath && onOpenRefs && <button type="button" className="meta-link" disabled={lockedNow} onClick={() => onOpenRefs(definition.sourcePath)}>打开已定位定义</button>}
      </div>;
    })}
    {(detail.dependencies ?? []).map((dependency, index) => {
      const entity = detail.entities.find((e) => e.id === dependency.entityId);
      return <p className="meta-note" key={`${dependency.entityId}/${index}`}><button type="button" className="meta-link" disabled={lockedNow || !entity}
        onClick={() => { if (entity) onSelect({ kind: "entity", entityId: entity.id }); }}>{entity?.displayName || entity?.name || dependency.entityId}</button> → {dependency.metadataPath} · 依赖只读</p>;
    })}
    {!detail.references?.length && !detail.dependencies?.length && <p className="meta-note">没有参照或依赖声明。</p>}
    {edit && <MetaOpDialog ariaLabel="编辑接口映射" title={`映射 ${expected?.displayName || expected?.name || edit.attrId}`} path={detail.path} sha={detail.sha256}
      ops={[{ op: "setMapping", entity: edit.entityId, interfaceId: edit.interfaceId, interfaceAttrId: edit.attrId, attrId: edit.target }]}
      valid={editValid && !locked} onStage={onStage} draftLabel={`修改 ${editEntity?.name ?? edit.entityId} 的接口映射`} onClose={() => setEdit(null)} onSaved={finish} onReload={reload}>
      <div className="meta-form"><label><span>当前实体字段</span><select aria-label="映射目标字段" value={edit.target} disabled={bindings.length > 1}
        onChange={(e) => setEdit((previous) => previous && { ...previous, target: e.target.value })}>
        <option value="">解除映射</option>
        {edit.target && !target && <option value={edit.target} disabled>{edit.target} · 目标字段不存在</option>}
        {(editEntity?.attrs ?? []).map((field) => {
          const compatible = !!expected && mappingCompatible(detail, field, expected);
          return <option key={field.id} value={field.id} disabled={!compatible}>{field.displayName || field.name} · {field.name}{compatible ? "" : " · 类型不兼容"}</option>;
        })}
      </select></label>
        {bindings.length > 1 && <p className="meta-note" role="status">此属性有重复映射，先解除全部重复项，再重新绑定。</p>}
        {!editValid && <p className="meta-field-error" role="alert">对象已变化或类型不兼容；请选择当前实体的兼容字段。路径映射保持只读。</p>}
        <p className="meta-note">应用后加入当前文档草稿，保存整个草稿后才写入文件。</p>
      </div>
    </MetaOpDialog>}
  </section>;
}
