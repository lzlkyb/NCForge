import { useEffect, useMemo, useRef, useState } from "react";
import { RELATION_KINDS, type BmfDetail, type BmfEnum, type RelationshipKind } from "../../lib/bmf";
import type { MetaSelection } from "../../lib/metaEditor";
import type { MetaStage } from "../../lib/metaDraft";
import { Icon } from "../ui/icon";
import { MetaActionButton, MetaDeleteButton } from "./MetaDeleteButton";
import { MetaEnumDialog } from "./MetaEnumDialog";
import { MetaRelationDialog } from "./MetaRelationDialog";

/** 枚举与连接关系共用草稿入口；未经验证的连接类型保留原文。 */
export function MetaEnumRelationSection({
  detail,
  onEdited,
  onReload,
  selection,
  onSelect,
  onStage,
  locked = false,
  onEditingChange,
}: {
  detail: BmfDetail;
  onEdited: () => void;
  onReload?: () => void;
  selection?: MetaSelection;
  onSelect?: (selection: MetaSelection) => void;
  onStage?: MetaStage;
  locked?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [enumTarget, setEnumTarget] = useState<{ en: BmfEnum | null } | null>(null);
  const [relationOpen, setRelationOpen] = useState(false);
  const editingCallback = useRef(onEditingChange);
  editingCallback.current = onEditingChange;
  useEffect(() => { editingCallback.current?.(!!enumTarget || relationOpen); return () => editingCallback.current?.(false); }, [enumTarget, relationOpen]);
  const reload = () => { setEnumTarget(null); setRelationOpen(false); (onReload ?? onEdited)(); };

  /** 关系里存的是 GUID；直接显示让用户无法判断两端是谁。 */
  const names = useMemo(() => {
    const entities = new Map<string, string>();
    const attrs = new Map<string, string>();
    for (const e of detail.entities) {
      entities.set(e.id, e.displayName || e.name);
      for (const a of e.attrs) attrs.set(a.id, a.name);
    }
    for (const reference of detail.references ?? []) entities.set(reference.id, reference.displayName || reference.name || reference.id);
    for (const itf of detail.interfaces ?? []) entities.set(itf.id, itf.displayName || itf.name);
    return { entities, attrs };
  }, [detail]);

  return (
    <fieldset className="meta-two-col meta-edit-fields" disabled={locked}>
      <div>
        <div className="meta-section-head">
          <h4 className="meta-section-title">枚举（{detail.enums.length}）</h4>
          <MetaActionButton icon="plus" onClick={() => setEnumTarget({ en: null })}>
            加枚举
          </MetaActionButton>
        </div>
        {detail.enums.length === 0 && <p className="meta-note">没有枚举定义。</p>}
        {detail.enums.map((en) => (
          <div key={en.id} className="meta-enum">
            <div className="meta-enum-head">
              <button type="button" className="meta-object-link" aria-pressed={selection?.kind === "enum" && selection.enumId === en.id} onClick={() => onSelect?.({ kind: "enum", enumId: en.id })}>{en.name}</button>
              <span className="text-muted-foreground">
                {en.displayName || "—"} · {en.items.length} 项
              </span>
              <span className="meta-row-actions">
                <button type="button" className="meta-link" onClick={() => setEnumTarget({ en })}>
                  <Icon name="edit" size={12} /> 编辑
                </button>
                <MetaDeleteButton
                  path={detail.path}
                  sha={detail.sha256}
                  id={en.id}
                  what={`枚举 ${en.name}`}
                  onDone={onEdited}
                  onReload={reload}
                  onStage={onStage}
                />
              </span>
            </div>
            <div className="meta-enum-items">
              {en.items.map((it) => (
                <span key={it.id} className="meta-enum-item" title={it.id}>
                  {it.value} = {it.display}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div>
        <div className="meta-section-head">
          <h4 className="meta-section-title">关系（{detail.relations.length}）</h4>
          <MetaActionButton icon="plus" onClick={() => setRelationOpen(true)}>
            加关系
          </MetaActionButton>
        </div>
        {detail.relations.length === 0 && <p className="meta-note">没有连接关系。</p>}
        {detail.relations.map((r) => (
          <div key={r.id} className="meta-relation">
            <div className="flex items-center justify-between gap-2">
              <button type="button" className="meta-object-link" aria-pressed={selection?.kind === "relation" && selection.relationId === r.id} onClick={() => onSelect?.({ kind: "relation", relationId: r.id })}>{r.name || r.kind}</button>
              {RELATION_KINDS.includes(r.kind as RelationshipKind) && <MetaDeleteButton
                path={detail.path}
                sha={detail.sha256}
                id={r.id}
                what={`关系 ${r.name || r.kind}`}
                onDone={onEdited}
                onReload={reload}
                onStage={onStage}
              />}
            </div>
            <div className="text-muted-foreground">
              {names.entities.get(r.source) ?? r.source} → {names.entities.get(r.target) ?? r.target}
              {r.srcAttrId
                ? `（${names.attrs.get(r.srcAttrId) ?? r.srcAttrId} → ${names.attrs.get(r.targetAttrId) ?? r.targetAttrId}）`
                : ""}
            </div>
            {!RELATION_KINDS.includes(r.kind as RelationshipKind) && <p className="meta-note">未经验证的关系类型 · 只读</p>}
          </div>
        ))}
      </div>
      {enumTarget && (
        <MetaEnumDialog
          path={detail.path}
          sha={detail.sha256}
          en={enumTarget.en}
          onStage={onStage}
          onClose={() => setEnumTarget(null)}
          onSaved={() => {
            setEnumTarget(null);
            onEdited();
          }}
          onReload={reload}
        />
      )}
      {relationOpen && (
        <MetaRelationDialog
          path={detail.path}
          sha={detail.sha256}
          detail={detail}
          onStage={onStage}
          onClose={() => setRelationOpen(false)}
          onSaved={() => {
            setRelationOpen(false);
            onEdited();
          }}
          onReload={reload}
        />
      )}
    </fieldset>
  );
}
