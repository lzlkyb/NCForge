import { RELATION_KINDS, type BmfDetail, type BmfIssue, type RelationshipKind } from "../../lib/bmf";
import { findMetaEntity, locateMetaIssue, selectedMetaEntity, type MetaSelection } from "../../lib/metaEditor";
import type { MetaStage } from "../../lib/metaDraft";
import { Icon } from "../ui/icon";
import { MetaDeleteButton } from "./MetaDeleteButton";
import { kindLabel } from "./MetaCanvasInfo";
import { MetaSemanticInspector } from "./MetaSemanticInspector";
import { MetaSourcePeek } from "./MetaSourcePeek";

export type MetaEditTarget = "field" | "addField" | "entity" | "addEntity" | "copy" | "relation" | "enum";

export function MetaInspector({ detail, sourceSha = detail.sha256, selection, issues, onEdit, onEdited, onReload, onSelect, onStage, locked = false, onEditingChange, onOpenRefs }: {
  detail: BmfDetail; selection: MetaSelection; issues: BmfIssue[];
  onEdit: (target: MetaEditTarget) => void; onEdited: () => void; onReload?: () => void; onSelect: (selection: MetaSelection) => void;
  onStage?: MetaStage; sourceSha?: string; locked?: boolean; onEditingChange?: (editing: boolean) => void; onOpenRefs?: (path: string) => void;
}) {
  const semantic = <MetaSemanticInspector detail={detail} selection={selection} onSelect={onSelect} onStage={onStage}
    onEdited={onEdited} onReload={onReload} locked={locked} onEditingChange={onEditingChange} onOpenRefs={onOpenRefs} />;
  if (selection.kind === "interface" || selection.kind === "interfaceAttr" || selection.kind === "reference") return semantic;
  const entity = selectedMetaEntity(detail, selection);
  const attr = selection.kind === "attr" ? entity?.attrs.find((a) => a.id === selection.attrId) : null;
  const relation = selection.kind === "relation" ? detail.relations.find((r) => r.id === selection.relationId) : null;
  const relationEditable = !!relation && RELATION_KINDS.includes(relation.kind as RelationshipKind);
  const en = selection.kind === "enum" ? detail.enums.find((e) => e.id === selection.enumId) : null;
  const id = attr?.id || relation?.id || en?.id || (selection.kind === "entity" ? entity?.id : "");
  const raw = attr?.raw || en?.raw || (selection.kind === "entity" ? entity?.raw : "") || "";
  const label = attr ? "字段属性" : relation ? "关系属性" : en ? "枚举属性" : selection.kind === "entity" ? "实体属性" : "组件属性";
  const name = attr?.displayName || attr?.name || relation?.name || (relation ? kindLabel(relation.kind) : "") || en?.displayName || en?.name || (selection.kind === "entity" ? entity?.displayName || entity?.name : detail.component.displayName || detail.component.name);
  const related = issues.filter((issue) => {
    const target = locateMetaIssue(detail, issue);
    return target && JSON.stringify(target) === JSON.stringify(selection);
  });
  const deleteButton = id && (!relation || relationEditable) ? <fieldset disabled={locked} className="meta-edit-fields"><MetaDeleteButton path={detail.path} sha={detail.sha256} id={id} what={`${label.slice(0, 2)} ${name}`} onDone={onEdited} onReload={onReload ?? onEdited} onStage={onStage} /></fieldset> : null;
  return <div className="meta-property-inspector">
    <header><div><span>{label}</span><h3>{name}</h3></div><Icon name={attr ? "symbolField" : relation ? "arrowRight" : en ? "javaEnum" : "layers"} size={19} /></header>
    <div className="meta-inspector-actions">
      {attr && <button type="button" className="meta-link" disabled={locked} onClick={() => onEdit("field")}><Icon name="edit" size={13} />编辑字段</button>}
      {selection.kind === "entity" && <><button type="button" className="meta-link" disabled={locked} onClick={() => onEdit("entity")}><Icon name="edit" size={13} />编辑实体</button>
        <button type="button" className="meta-link" disabled={locked} onClick={() => onEdit("copy")}>复制实体</button></>}
      {en && <button type="button" className="meta-link" disabled={locked} onClick={() => onEdit("enum")}><Icon name="edit" size={13} />编辑枚举</button>}
      {relationEditable && <button type="button" className="meta-link" disabled={locked} onClick={() => onEdit("relation")}><Icon name="edit" size={13} />编辑关系</button>}
      {deleteButton}
    </div>
    {attr ? <>
      <Group title="基本信息"><KV label="字段名" value={attr.name} mono /><KV label="显示名" value={attr.displayName} /><KV label="类型" value={attr.typeName || attr.dataType} /><KV label="顺序" value={attr.sequence} /></Group>
      <Group title="数据库映射"><KV label="列名" value={attr.field} mono /><KV label="列类型" value={attr.dbType || attr.fieldType} /><KV label="长度 / 精度" value={`${attr.length ?? "—"} / ${attr.precision ?? "—"}`} /><KV label="约束" value={`${attr.isKey ? "主键 · " : ""}${attr.nullable ? "允许为空" : "不能为空"}`} /><KV label="默认值" value={attr.defaultValue} /></Group>
      <Group title="关系与引用"><KV label="数据类型" value={attr.style} /><KV label="引用模型" value={attr.refModel} /><KV label="引用目标" value={attr.refTarget} /></Group>
    </> : relation ? <>
      <Group title="关系定义"><KV label="关系类型" value={kindLabel(relation.kind)} /><KV label="技术类型" value={relation.kind} mono />
        {[{ id: relation.source, attrId: relation.srcAttrId, label: "来源" }, { id: relation.target, attrId: relation.targetAttrId, label: "目标" }].map((end) => {
          const target = findMetaEntity(detail, end.id);
          const field = target?.attrs.find((a) => a.id === end.attrId);
          const reference = detail.references?.find((r) => r.id === end.id);
          const itf = detail.interfaces?.find((i) => i.id === end.id);
          return <div key={end.label} className="meta-relation-end"><span>{end.label}</span><button type="button" className="meta-link" disabled={locked || (!target && !reference && !itf)} onClick={() => {
            if (target) onSelect(field ? { kind: "attr", entityId: target.id, attrId: field.id } : { kind: "entity", entityId: target.id });
            else if (reference) onSelect({ kind: "reference", referenceId: reference.id });
            else if (itf) onSelect({ kind: "interface", interfaceId: itf.id });
          }}>{target?.displayName || target?.name || reference?.displayName || reference?.name || itf?.displayName || itf?.name || end.id}{field ? ` / ${field.name}` : ""}<Icon name="arrowRight" size={12} /></button></div>;
        })}<KV label="来源多重性" value={relation.sourceConstraint} /><KV label="目标多重性" value={relation.targetConstraint} /><KV label="接口实现类" value={relation.implementationClass} /></Group>
        {!relationEditable && <p className="meta-note">此关系类型的写入语义尚未验证，保留原文只读。</p>}
    </> : en ? <><Group title="枚举定义"><KV label="技术名" value={en.name} mono /><KV label="类型" value={en.typeName} /><KV label="类名" value={en.fullClass} mono /></Group><Group title={`枚举值 · ${en.items.length}`}>{en.items.map((item) => <KV key={item.id} label={item.value} value={item.display} />)}</Group></>
      : selection.kind === "entity" && entity ? <>
        <Group title="基本信息"><KV label="技术名" value={entity.name} mono /><KV label="主实体" value={entity.isPrimary ? "是" : "否"} /><KV label="字段数量" value={entity.attrs.length} /></Group>
        <Group title="类与数据库"><KV label="VO 类" value={entity.fullClass} mono /><KV label="表名" value={entity.table} mono /><KV label="访问器" value={entity.accessor} mono /><KV label="主键字段" value={entity.attrs.find((a) => a.id === entity.keyAttrId)?.name} /></Group>
      </> : <>
        <Group title="组件身份"><KV label="技术名" value={detail.component.name} mono /><KV label="命名空间" value={detail.component.namespace} /><KV label="所属模块" value={detail.component.ownModule} /><KV label="版本" value={detail.component.version} /></Group>
        <Group title="文件"><KV label="编码 / 换行" value={`${detail.encoding} / ${detail.eol}`} /><KV label="大小" value={`${(detail.size / 1024).toFixed(1)} KB`} /><KV label="生成风格" value={detail.component.genCodeStyle} /></Group>
        <p className="meta-note">选择模型、字段或关系查看属性。模型位置只保存在视图中。</p>
      </>}
    {id && <details className="meta-property-group"><summary>高级 · 只读</summary><KV label="对象 ID" value={id} mono />{attr && <KV label="dataType" value={attr.dataType} />}
      <MetaSourcePeek path={detail.path} id={id} sha={sourceSha} raw={raw} disabled={locked} draft={sourceSha !== detail.sha256} />
    </details>}
    {(attr || selection.kind === "entity") && semantic}
    {related.length > 0 && <Group title={`当前对象问题 · ${related.length}`}>{related.map((issue) => <p key={issue.id || issue.code} className="meta-note">{issue.title}：{issue.action}</p>)}</Group>}
    {detail.unknownTags.length > 0 && <details className="meta-property-group"><summary>未识别节点 · 只读</summary><p className="meta-note">{detail.unknownTags.join("、")}。写回时保留原始内容。</p></details>}
  </div>;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="meta-property-group"><h4>{title}</h4>{children}</section>;
}
function KV({ label, value, mono = false }: { label: string; value: string | number | null | undefined; mono?: boolean }) {
  return <div className="meta-property-row"><span>{label}</span><span className={mono ? "meta-mono" : undefined}>{value === "" || value == null ? "—" : value}</span></div>;
}
