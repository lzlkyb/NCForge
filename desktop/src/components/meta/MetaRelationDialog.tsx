import { useState } from "react";
import { RELATION_KINDS, type BmfDetail, type BmfEditOp, type BmfRelation, type RelationshipKind } from "../../lib/bmf";
import type { MetaStage } from "../../lib/metaDraft";
import { Input } from "../ui/input";
import { MetaOpDialog } from "./MetaOpDialog";

const KIND_LABEL: Record<RelationshipKind, string> = {
  AggregationRelation: "聚合（主子表）",
  relation: "关联 / 参照",
  busiitfconnection: "业务接口实现",
  ExtendConnection: "实体继承",
};
const MULTIPLICITIES = ["1", "0..1", "0..n", "1..n"];
const CLASS = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

/**
 * 新增关系按真实对象类别选择目标；已有关系仅修改验证过的属性，不猜测端点语义。
 * `initial` 供画布拖拽建关系时预填两端——它只是初始值，之后仍可改。
 */
export function MetaRelationDialog({
  path,
  sha,
  detail,
  initial,
  onClose,
  onSaved,
  onReload,
  relation = null,
  onStage,
}: {
  path: string;
  sha: string;
  detail: BmfDetail;
  initial?: { source?: string; target?: string };
  onClose: () => void;
  onSaved: () => void;
  onReload?: () => void;
  relation?: BmfRelation | null;
  onStage?: MetaStage;
}) {
  const [newId] = useState(() => relation?.id ?? crypto.randomUUID());
  const [form, setForm] = useState({
    kind: relation?.kind ?? "AggregationRelation",
    name: relation?.displayName ?? "",
    source: relation?.source ?? initial?.source ?? detail.entities[0]?.id ?? "",
    target: relation?.target ?? initial?.target ?? detail.entities[1]?.id ?? "",
    srcAttrId: relation?.srcAttrId ?? "",
    targetAttrId: relation?.targetAttrId ?? "",
    sourceConstraint: relation ? relation.sourceConstraint ?? "" : "1",
    targetConstraint: relation ? relation.targetConstraint ?? "" : "0..n",
    implementationClass: relation?.implementationClass ?? "",
  });
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const src = detail.entities.find((e) => e.id === form.source);
  const tgt = detail.entities.find((e) => e.id === form.target);
  const targetsFor = (kind: string) => {
    const interfaces = detail.interfaces ?? [];
    const isInterface = (id: string) => interfaces.some((i) => i.id === id);
    const entities = detail.entities.map((e) => ({ id: e.id, name: e.displayName || e.name, kind: "实体" }));
    const references = (detail.references ?? []).filter((r) => kind === "busiitfconnection" ? isInterface(r.refId) : !isInterface(r.refId))
      .map((r) => ({ id: r.id, name: r.displayName || r.name || r.id, kind: "引用" }));
    if (kind === "AggregationRelation") return entities;
    if (kind === "busiitfconnection") return [...interfaces.filter((i) => !i.external).map((i) => ({ id: i.id, name: i.displayName || i.name, kind: "接口" })), ...references];
    return [...entities, ...references];
  };
  const targets = targetsFor(form.kind);
  const supported = RELATION_KINDS.includes(form.kind as RelationshipKind);
  const constrained = form.kind === "AggregationRelation" || form.kind === "relation" || relation?.sourceConstraint != null || relation?.targetConstraint != null;
  const hasImplementation = form.kind === "busiitfconnection" || form.kind === "ExtendConnection" || relation?.implementationClass != null;
  const constraintsOk = !constrained || [form.sourceConstraint, form.targetConstraint].every((v, i) => MULTIPLICITIES.includes(v)
    || (!!relation && v === (i === 0 ? relation.sourceConstraint ?? "" : relation.targetConstraint ?? "")));
  const classOk = !hasImplementation || !form.implementationClass.trim() || CLASS.test(form.implementationClass.trim())
    || (!!relation && form.implementationClass === (relation.implementationClass ?? ""));
  const valid = supported && constraintsOk && classOk && (relation ? detail.relations.some((r) => r.id === relation.id)
    : !!src && !!targets.find((t) => t.id === form.target) && src.id !== form.target
      && (!form.srcAttrId || src.attrs.some((a) => a.id === form.srcAttrId)) && (!form.targetAttrId || !!tgt?.attrs.some((a) => a.id === form.targetAttrId)));
  const ops = (): BmfEditOp[] => {
    const out: BmfEditOp[] = relation ? [] : [{ op: "addRelation", id: newId, kind: form.kind as RelationshipKind,
      name: form.name.trim(), source: form.source, target: form.target, srcAttrId: form.srcAttrId, targetAttrId: form.targetAttrId }];
    const set = (name: string, value: string) => out.push({ op: "setAttr", id: newId, name, value });
    if (relation && form.name !== (relation.displayName ?? "")) set("displayName", form.name);
    if (constrained) {
      if (form.sourceConstraint !== (relation ? relation.sourceConstraint ?? "" : "1")) set("sourceConstraint", form.sourceConstraint);
      if (form.targetConstraint !== (relation ? relation.targetConstraint ?? "" : form.kind === "AggregationRelation" ? "0..n" : "1")) set("targetConstraint", form.targetConstraint);
    }
    if (hasImplementation && form.implementationClass !== (relation?.implementationClass ?? "")) set("bizItfImpClassName", form.implementationClass);
    return out;
  };

  return (
    <MetaOpDialog
      ariaLabel={relation ? "编辑关系" : "新增关系"}
      title={
        <>
          {relation ? "编辑关系" : "新增关系"}
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">{relation ? "端点保持原文，只修改已验证属性" : "源为当前实体，目标按关系类别选择"}</span>
        </>
      }
      path={path}
      sha={sha}
      ops={ops()}
      valid={valid}
      onClose={onClose}
      onSaved={onSaved}
      onReload={onReload}
      onStage={onStage}
      draftLabel={`${relation ? "修改" : "新增"}关系 ${relation?.name || form.name || KIND_LABEL[form.kind as RelationshipKind]}`}
    >
      <div className="meta-form">
        <label>
          <span>关系类型</span>
          <select
            aria-label="关系类型"
            value={form.kind}
            disabled={!!relation}
            onChange={(e) => patch({ kind: e.target.value, target: targetsFor(e.target.value).some((t) => t.id === form.target) ? form.target : "",
              srcAttrId: "", targetAttrId: "", sourceConstraint: "1", targetConstraint: e.target.value === "AggregationRelation" ? "0..n" : "1" })}
          >
            {!supported && <option value={form.kind}>{form.kind} · 只读</option>}
            {RELATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{relation ? "显示名" : "关系名"}</span>
          <Input aria-label={relation ? "关系显示名" : "关系名"} value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="可留空" disabled={!supported} />
        </label>
        <label>
          <span>源实体</span>
          <select
            aria-label="源实体"
            value={form.source}
            disabled={!!relation}
            onChange={(e) => patch({ source: e.target.value, srcAttrId: "" })}
          >
            <option value="">（选择）</option>
            {relation && form.source && !src && <option value={form.source}>{form.source} · 原始端点</option>}
            {detail.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.displayName ? ` · ${e.displayName}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>源属性（可选，端点属于实体时可用）</span>
          <select
            aria-label="源属性"
            value={form.srcAttrId}
            disabled={!!relation || !src}
            onChange={(e) => patch({ srcAttrId: e.target.value })}
          >
            <option value="">（不指定）</option>
            {relation && form.srcAttrId && !src?.attrs.some((a) => a.id === form.srcAttrId) && <option value={form.srcAttrId}>{form.srcAttrId} · 原始属性</option>}
            {(src?.attrs ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>目标对象</span>
          <select
            aria-label="目标实体"
            value={form.target}
            disabled={!!relation}
            onChange={(e) => patch({ target: e.target.value, targetAttrId: "" })}
          >
            <option value="">（选择）</option>
            {relation && form.target && !targets.some((t) => t.id === form.target) && <option value={form.target}>{form.target} · 原始端点</option>}
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name} · {target.kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>目标属性（可选）</span>
          <select
            aria-label="目标属性"
            value={form.targetAttrId}
            disabled={!!relation || !tgt}
            onChange={(e) => patch({ targetAttrId: e.target.value })}
          >
            <option value="">（不指定）</option>
            {relation && form.targetAttrId && !tgt?.attrs.some((a) => a.id === form.targetAttrId) && <option value={form.targetAttrId}>{form.targetAttrId} · 原始属性</option>}
            {(tgt?.attrs ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {src && tgt && src.id === tgt.id && (
          <span className="meta-field-error">关系两端不能是同一个实体</span>
        )}
        {constrained && [{ key: "sourceConstraint" as const, label: "来源多重性" }, { key: "targetConstraint" as const, label: "目标多重性" }].map(({ key, label }) => <label key={key}><span>{label}</span>
          <select aria-label={label} value={form[key]} disabled={!supported} onChange={(e) => patch({ [key]: e.target.value })}>
            {!MULTIPLICITIES.includes(form[key]) && <option value={form[key]}>{form[key] || "未声明（保留）"}</option>}
            {MULTIPLICITIES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select></label>)}
        {hasImplementation && <label><span>接口实现类</span><Input aria-label="接口实现类" value={form.implementationClass} disabled={!supported}
          onChange={(e) => patch({ implementationClass: e.target.value })} aria-invalid={!classOk || undefined} placeholder="完整类名，可留空" />
          {!classOk && <span className="meta-field-error" role="alert">实现类必须是完整类名。</span>}</label>}
        {!supported && <p className="meta-note" role="status">此关系类型未经写入验证，保留原文只读。</p>}
      </div>
    </MetaOpDialog>
  );
}
