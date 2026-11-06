import { useEffect, useRef, useState } from "react";
import type { BmfDetail } from "../../lib/bmf";
import type { MetaStage } from "../../lib/metaDraft";
import type { MetaSelection } from "../../lib/metaEditor";
import { Input } from "../ui/input";
import { MetaOpDialog } from "./MetaOpDialog";

const CLASS = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

/** 语义对象与实体共用检查器；外部结构只读，已有访问器参数才有草稿编辑入口。 */
export function MetaSemanticInspector({ detail, selection, onSelect, onStage, onEdited, onReload, locked = false, onEditingChange, onOpenRefs }: {
  detail: BmfDetail; selection: MetaSelection; onSelect: (selection: MetaSelection) => void;
  onStage?: MetaStage; onEdited: () => void; onReload?: () => void; locked?: boolean;
  onEditingChange?: (editing: boolean) => void; onOpenRefs?: (path: string) => void;
}) {
  const [edit, setEdit] = useState<{ entityId: string; name: string; value: string } | null>(null);
  const editingCallback = useRef(onEditingChange);
  editingCallback.current = onEditingChange;
  useEffect(() => { editingCallback.current?.(!!edit); return () => editingCallback.current?.(false); }, [edit]);
  const itf = selection.kind === "interface" || selection.kind === "interfaceAttr" ? detail.interfaces?.find((i) => i.id === selection.interfaceId) : undefined;
  const attr = selection.kind === "interfaceAttr" ? itf?.attrs.find((a) => a.id === selection.attrId) : undefined;
  const reference = selection.kind === "reference" ? detail.references?.find((r) => r.id === selection.referenceId) : undefined;
  const entity = selection.kind === "entity" || selection.kind === "attr" ? detail.entities.find((e) => e.id === selection.entityId) : undefined;
  const field = selection.kind === "attr" ? entity?.attrs.find((a) => a.id === selection.attrId) : undefined;
  const config = selection.kind === "entity" ? entity?.accessorConfig : undefined;
  const definition = reference ? detail.interfaces?.find((i) => i.id === reference.refId) : itf;
  const mapped = itf ? detail.entities.flatMap((e) => (e.mappings ?? []).filter((m) => m.interfaceId === itf.id && (!attr || m.interfaceAttrId === attr.id)).map((m) => ({ entity: e, mapping: m }))) : [];
  const currentParam = edit ? detail.entities.find((e) => e.id === edit.entityId)?.accessorConfig?.properties.filter((p) => p.name === edit.name) : undefined;
  const valid = !!edit && currentParam?.length === 1 && (edit.name !== "wrapclsname" || CLASS.test(edit.value.trim()));
  const lockedNow = locked || !!edit;

  if (itf || reference) return <div className="meta-property-inspector">
    <header><div><span>{attr ? "接口属性" : reference ? "参照属性" : "业务接口"}</span><h3>{attr?.displayName || attr?.name || reference?.displayName || reference?.name || itf?.displayName || itf?.name}</h3></div></header>
    <section className="meta-property-group"><h4>基本信息 · 只读</h4>
      {attr ? <><KV label="技术名" value={attr.name} /><KV label="类型" value={attr.typeName || attr.dataType} /><KV label="样式" value={attr.style} /><KV label="数据库类型" value={attr.dbType} /><KV label="顺序" value={attr.sequence} /></>
        : reference ? <><KV label="引用 ID" value={reference.refId} /><KV label="类名" value={reference.fullClass} /><KV label="所属模块" value={reference.module} /><KV label="元数据路径" value={reference.metadataPath} /><KV label="解析状态" value={reference.resolution || "已定位定义"} /></>
          : <><KV label="技术名" value={itf?.name} /><KV label="类名" value={itf?.fullClass} /><KV label="属性数" value={itf?.attrs.length} /></>}
      <p className="meta-note">{definition?.external ? "外部接口定义只读。当前文档只编辑实体字段映射。" : "接口与参照结构保留原文；尚未开放的结构修改保持只读。"}</p>
      {definition?.sourcePath && onOpenRefs && <button type="button" className="meta-link" disabled={lockedNow} onClick={() => onOpenRefs(definition.sourcePath)}>打开已定位定义</button>}
    </section>
    {itf && !attr && <section className="meta-property-group"><h4>接口属性</h4>{itf.attrs.map((item) => <div className="meta-property-row" key={item.id}><button type="button" className="meta-link" disabled={lockedNow}
      onClick={() => onSelect({ kind: "interfaceAttr", interfaceId: itf.id, attrId: item.id })}>{item.displayName || item.name}</button><span>{item.typeName || item.dataType || "未声明类型"}</span></div>)}</section>}
    {itf && <section className="meta-property-group"><h4>映射到实体字段</h4>{mapped.length ? mapped.map(({ entity: owner, mapping }, index) => {
      const target = owner.attrs.find((a) => a.id === mapping.attrId);
      return <div key={`${owner.id}/${index}`} className="meta-property-row"><span>{owner.displayName || owner.name}</span><button type="button" className="meta-link" disabled={lockedNow || !target}
        onClick={() => { if (target) onSelect({ kind: "attr", entityId: owner.id, attrId: target.id }); }}>{target?.name || mapping.attrId || "未绑定"}</button>
        {(mapping.attrPath || mapping.attrPathId) && <span>路径映射 · 只读</span>}</div>;
    }) : <p className="meta-note">尚未绑定实体字段。</p>}</section>}
    <details className="meta-property-group"><summary>高级 · 只读</summary><KV label="对象 ID" value={attr?.id || reference?.id || itf?.id} /><KV label="定义 SHA" value={definition?.definitionSha} /></details>
  </div>;

  return <>
    {field && entity && <section className="meta-property-group"><h4>接口映射</h4>{(entity.mappings ?? []).filter((m) => m.attrId === field.id).map((mapping, index) => {
      const target = detail.interfaces?.find((i) => i.id === mapping.interfaceId);
      const expected = target?.attrs.find((a) => a.id === mapping.interfaceAttrId);
      return <div className="meta-property-row" key={`${mapping.interfaceId}/${index}`}><span>{target?.displayName || target?.name || mapping.interfaceId}</span><button type="button" className="meta-link" disabled={lockedNow || !expected}
        onClick={() => { if (target && expected) onSelect({ kind: "interfaceAttr", interfaceId: target.id, attrId: expected.id }); }}>{expected?.displayName || expected?.name || mapping.interfaceAttrId}</button>
        {(mapping.attrPath || mapping.attrPathId) && <span>路径映射 · 只读</span>}</div>;
    })}{!entity.mappings?.some((m) => m.attrId === field.id) && <p className="meta-note">当前字段没有接口映射。</p>}</section>}
    {config && entity && <section className="meta-property-group"><h4>访问器参数</h4><KV label="访问器" value={config.displayName || config.name} /><KV label="类名" value={config.fullClass} />
      {config.properties.map((property, index) => <div className="meta-relation" key={`${property.name}/${index}`}><KV label={property.displayName || property.name} value={property.value} />
        <button type="button" className="meta-link" disabled={lockedNow || !onStage || config.properties.filter((p) => p.name === property.name).length !== 1}
          onClick={() => setEdit({ entityId: entity.id, name: property.name, value: property.value })}>编辑参数 {property.name}</button>
        {config.properties.filter((p) => p.name === property.name).length > 1 && <p className="meta-note">参数名重复，保留原文只读。</p>}
      </div>)}{!config.properties.length && <p className="meta-note">这个访问器没有参数；不添加未声明的参数。</p>}
    </section>}
    {edit && <MetaOpDialog inline ariaLabel="编辑访问器参数" title={`访问器参数 ${edit.name}`} path={detail.path} sha={detail.sha256}
      ops={[{ op: "setAccessorProperty", entity: edit.entityId, name: edit.name, value: edit.value }]}
      valid={valid && !locked} onStage={onStage} draftLabel={`修改访问器参数 ${edit.name}`} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onEdited(); }}
      onReload={() => { setEdit(null); (onReload ?? onEdited)(); }}>
      <div className="meta-form"><label><span>参数值</span><Input aria-label={`访问器参数 ${edit.name}`} value={edit.value} aria-invalid={!valid || undefined}
        onChange={(e) => setEdit((previous) => previous && { ...previous, value: e.target.value })} /></label>
        {!valid && <p className="meta-field-error" role="alert">{edit.name === "wrapclsname" ? "包装类参数必须是完整类名。" : "此参数已不存在或存在重名，不能修改。"}</p>}
        <p className="meta-note">应用到当前文档草稿。未知参数保留原文，不会创建新参数。</p>
      </div>
    </MetaOpDialog>}
  </>;
}

function KV({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <div className="meta-property-row"><span>{label}</span><span>{value === "" || value == null ? "—" : value}</span></div>;
}
