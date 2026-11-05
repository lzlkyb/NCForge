import { useState } from "react";
import { RELATION_KINDS, type BmfDetail, type BmfEditOp, type RelationshipKind } from "../../lib/bmf";
import { Input } from "../ui/input";
import { MetaOpDialog } from "./MetaOpDialog";

const KIND_LABEL: Record<RelationshipKind, string> = {
  AggregationRelation: "聚合（主子表）",
  Reference: "参照",
  busiitfconnection: "业务接口",
};

/**
 * 新增连接关系。两端必须已存在的实体；属性可选，选了必须属于对应实体。
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
}: {
  path: string;
  sha: string;
  detail: BmfDetail;
  initial?: { source?: string; target?: string };
  onClose: () => void;
  onSaved: () => void;
  onReload?: () => void;
}) {
  const [form, setForm] = useState({
    kind: "AggregationRelation" as RelationshipKind,
    name: "",
    source: initial?.source ?? detail.entities[0]?.id ?? "",
    target: initial?.target ?? detail.entities[1]?.id ?? "",
    srcAttrId: "",
    targetAttrId: "",
  });
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const src = detail.entities.find((e) => e.id === form.source);
  const tgt = detail.entities.find((e) => e.id === form.target);
  const valid = !!src && !!tgt && src.id !== tgt.id;

  const ops = (): BmfEditOp[] => [
    {
      op: "addRelation",
      kind: form.kind,
      name: form.name.trim(),
      source: form.source,
      target: form.target,
      srcAttrId: form.srcAttrId,
      targetAttrId: form.targetAttrId,
    },
  ];

  return (
    <MetaOpDialog
      ariaLabel="新增关系"
      title={
        <>
          新增关系
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">两端必须是本组件内的实体</span>
        </>
      }
      path={path}
      sha={sha}
      ops={ops()}
      valid={valid}
      onClose={onClose}
      onSaved={onSaved}
      onReload={onReload}
    >
      <div className="meta-form">
        <label>
          <span>关系类型</span>
          <select
            aria-label="关系类型"
            value={form.kind}
            onChange={(e) => patch({ kind: e.target.value as RelationshipKind })}
          >
            {RELATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>关系名</span>
          <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="可留空" />
        </label>
        <label>
          <span>源实体</span>
          <select
            aria-label="源实体"
            value={form.source}
            onChange={(e) => patch({ source: e.target.value, srcAttrId: "" })}
          >
            <option value="">（选择）</option>
            {detail.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.displayName ? ` · ${e.displayName}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>源属性（可选）</span>
          <select
            aria-label="源属性"
            value={form.srcAttrId}
            onChange={(e) => patch({ srcAttrId: e.target.value })}
          >
            <option value="">（不指定）</option>
            {(src?.attrs ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>目标实体</span>
          <select
            aria-label="目标实体"
            value={form.target}
            onChange={(e) => patch({ target: e.target.value, targetAttrId: "" })}
          >
            <option value="">（选择）</option>
            {detail.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.displayName ? ` · ${e.displayName}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>目标属性（可选）</span>
          <select
            aria-label="目标属性"
            value={form.targetAttrId}
            onChange={(e) => patch({ targetAttrId: e.target.value })}
          >
            <option value="">（不指定）</option>
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
      </div>
    </MetaOpDialog>
  );
}
