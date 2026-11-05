import { useMemo, useState } from "react";
import type { BmfDetail, BmfEnum } from "../../lib/bmf";
import { Icon } from "../ui/icon";
import { MetaActionButton, MetaDeleteButton } from "./MetaDeleteButton";
import { MetaEnumDialog } from "./MetaEnumDialog";
import { MetaRelationDialog } from "./MetaRelationDialog";

/** 枚举与连接关系：看清结构 + 增删改入口。字段表在 MetaDetails，这里只管右侧语义。 */
export function MetaEnumRelationSection({
  detail,
  onEdited,
}: {
  detail: BmfDetail;
  onEdited: () => void;
}) {
  const [enumTarget, setEnumTarget] = useState<{ en: BmfEnum | null } | null>(null);
  const [relationOpen, setRelationOpen] = useState(false);

  /** 关系里存的是 GUID；直接显示让用户无法判断两端是谁。 */
  const names = useMemo(() => {
    const entities = new Map<string, string>();
    const attrs = new Map<string, string>();
    for (const e of detail.entities) {
      entities.set(e.id, e.displayName || e.name);
      for (const a of e.attrs) attrs.set(a.id, a.name);
    }
    return { entities, attrs };
  }, [detail]);

  return (
    <section className="meta-two-col">
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
              <span className="font-medium">{en.name}</span>
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
                  onReload={onEdited}
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
              <span className="font-medium">{r.kind}</span>
              <MetaDeleteButton
                path={detail.path}
                sha={detail.sha256}
                id={r.id}
                what={`关系 ${r.name || r.kind}`}
                onDone={onEdited}
                onReload={onEdited}
              />
            </div>
            <div className="text-muted-foreground">
              {names.entities.get(r.source) ?? r.source} → {names.entities.get(r.target) ?? r.target}
              {r.srcAttrId
                ? `（${names.attrs.get(r.srcAttrId) ?? r.srcAttrId} → ${names.attrs.get(r.targetAttrId) ?? r.targetAttrId}）`
                : ""}
            </div>
          </div>
        ))}
      </div>
      {enumTarget && (
        <MetaEnumDialog
          path={detail.path}
          sha={detail.sha256}
          en={enumTarget.en}
          onClose={() => setEnumTarget(null)}
          onSaved={() => {
            setEnumTarget(null);
            onEdited();
          }}
          onReload={() => {
            setEnumTarget(null);
            onEdited();
          }}
        />
      )}
      {relationOpen && (
        <MetaRelationDialog
          path={detail.path}
          sha={detail.sha256}
          detail={detail}
          onClose={() => setRelationOpen(false)}
          onSaved={() => {
            setRelationOpen(false);
            onEdited();
          }}
          onReload={() => {
            setRelationOpen(false);
            onEdited();
          }}
        />
      )}
    </section>
  );
}
