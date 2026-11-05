import { useEffect, useMemo, useRef, useState } from "react";
import type { BmfAttr, BmfDetail, BmfEntity } from "../../lib/bmf";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { MetaActionButton, MetaDeleteButton } from "./MetaDeleteButton";
import { MetaCopyEntityDialog } from "./MetaCopyEntityDialog";
import { MetaEditDialog } from "./MetaEditDialog";
import { MetaEntityDialog } from "./MetaEntityDialog";
import { MetaEnumRelationSection } from "./MetaEnumRelationSection";
import { MetaOverview } from "./MetaOverview";

/** 概览 + 实体字段 + 枚举关系。只负责看清结构；所有写操作先预览 diff 再落盘。 */
export function MetaDetails({
  detail,
  onEdited,
}: {
  detail: BmfDetail;
  onEdited: () => void;
}) {
  const [entityId, setEntityId] = useState(() => detail.entities[0]?.id ?? "");
  const [attrSearch, setAttrSearch] = useState("");
  // 存 id 而不是属性对象：保存后父级会重新加载详情，存对象会把旧值一直显示在检查器里。
  const [selectedAttrId, setSelectedAttrId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<{ attr: BmfAttr | null; entity: BmfEntity } | null>(null);
  const [entityTarget, setEntityTarget] = useState<{ entity: BmfEntity | null } | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const inspectorRef = useRef<HTMLDivElement>(null);

  const entity = detail.entities.find((e) => e.id === entityId) ?? detail.entities[0];
  const selectedAttr = entity?.attrs.find((a) => a.id === selectedAttrId) ?? null;

  // 检查器在字段表之后，长表里选中靠上的行时它在折叠线以下；选中即滚到可见。
  useEffect(() => {
    if (selectedAttrId) inspectorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedAttrId]);

  const attrs = useMemo(() => {
    if (!entity) return [];
    const q = attrSearch.trim().toLowerCase();
    if (!q) return entity.attrs;
    return entity.attrs.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.displayName.toLowerCase().includes(q) ||
        a.field.toLowerCase().includes(q) ||
        a.typeName.toLowerCase().includes(q),
    );
  }, [entity, attrSearch]);

  const reload = () => {
    setSelectedAttrId(null);
    onEdited();
  };

  return (
    <div className="meta-detail-body">
      <MetaOverview detail={detail} />

      {detail.entities.length === 0 ? (
        <div className="meta-note">
          <p>这个组件没有实体（纯枚举 / 纯接口 / 历史残留都是合法形态，不一定是解析失败）。</p>
          <MetaActionButton icon="plus" onClick={() => setEntityTarget({ entity: null })}>
            加实体
          </MetaActionButton>
        </div>
      ) : (
        <>
          <div className="meta-entity-tabs">
            {detail.entities.map((e) => (
              <button
                key={e.id}
                type="button"
                className={`meta-entity-tab ${e.id === entity?.id ? "is-active" : ""}`}
                onClick={() => {
                  setEntityId(e.id);
                  setSelectedAttrId(null);
                }}
              >
                <span>{e.name}</span>
                <span className="meta-entity-meta">
                  {e.table || "无表名"} · {e.attrs.length}
                </span>
                {e.isPrimary && <span className="meta-pk-badge">主</span>}
              </button>
            ))}
            <MetaActionButton icon="plus" onClick={() => setEntityTarget({ entity: null })}>
              加实体
            </MetaActionButton>
          </div>

          {entity && (
            <>
              <div className="meta-entity-head">
                <div>
                  <div className="text-[13px] font-medium">
                    {entity.displayName || entity.name}
                    <span className="ml-2 text-[11px] font-normal text-muted-foreground">{entity.fullClass}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    表 {entity.table || "—"} · 访问器 {shortAccessor(entity.accessor)} · 主键{" "}
                    {entity.attrs.find((a) => a.id === entity.keyAttrId)?.name ?? "未指向"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="meta-attr-search">
                    <Icon name="search" size={12} className="text-muted-foreground" />
                    <Input
                      value={attrSearch}
                      onChange={(ev) => setAttrSearch(ev.target.value)}
                      placeholder="过滤字段"
                      aria-label="过滤字段"
                      className="h-6 border-0 bg-transparent px-1 text-[12px] focus-visible:ring-0"
                    />
                  </div>
                  <button type="button" className="meta-link" onClick={() => setEditTarget({ attr: null, entity })}>
                    <Icon name="plus" size={12} /> 加字段
                  </button>
                  <MetaActionButton icon="edit" onClick={() => setEntityTarget({ entity })}>
                    编辑实体
                  </MetaActionButton>
                  <MetaActionButton icon="plus" onClick={() => setCopyOpen(true)}>
                    复制实体
                  </MetaActionButton>
                  <MetaDeleteButton
                    path={detail.path}
                    sha={detail.sha256}
                    id={entity.id}
                    what={`实体 ${entity.name}`}
                    onDone={reload}
                    onReload={reload}
                  />
                </div>
              </div>

              <div className="meta-attr-table">
                <div className="meta-attr-row meta-attr-head">
                  <span>字段</span>
                  <span>显示名</span>
                  <span>类型</span>
                  <span>列名</span>
                  <span className="text-right">长度</span>
                  <span>约束</span>
                </div>
                {attrs.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`meta-attr-row ${selectedAttrId === a.id ? "is-active" : ""}`}
                    onClick={() => setSelectedAttrId(a.id)}
                  >
                    <span className="meta-mono">{a.name}</span>
                    <span>{a.displayName || "—"}</span>
                    <span title={a.typeName}>{a.typeName || a.dataType || "—"}</span>
                    <span className="meta-mono">{a.field || "—"}</span>
                    <span className="text-right meta-mono">{a.length ?? "—"}</span>
                    <span className="meta-constraints">
                      {a.isKey && <span className="meta-tag meta-tag-key">PK</span>}
                      {a.nullable ? <span className="meta-tag">空</span> : <span className="meta-tag meta-tag-strong">非空</span>}
                      {a.style === "ARRAY" && <span className="meta-tag meta-tag-array">ARRAY</span>}
                    </span>
                  </button>
                ))}
              </div>

              {selectedAttr && (
                <div className="meta-inspector" ref={inspectorRef}>
                  <div className="meta-inspector-head">
                    <span className="text-[12px] font-medium">字段检查器</span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="meta-link"
                        onClick={() => setEditTarget({ attr: selectedAttr, entity })}
                      >
                        <Icon name="edit" size={12} /> 编辑
                      </button>
                      <MetaDeleteButton
                        path={detail.path}
                        sha={detail.sha256}
                        id={selectedAttr.id}
                        what={`字段 ${selectedAttr.name}`}
                        onDone={reload}
                        onReload={reload}
                      />
                      <button type="button" className="meta-link" onClick={() => setSelectedAttrId(null)}>
                        关闭
                      </button>
                    </div>
                  </div>
                  <div className="meta-inspector-grid">
                    <KV k="id" v={selectedAttr.id} />
                    <KV k="sequence" v={String(selectedAttr.sequence)} />
                    <KV k="typeName" v={selectedAttr.typeName} />
                    <KV k="dataType" v={selectedAttr.dataType} />
                    <KV k="dataTypeStyle" v={selectedAttr.style} />
                    <KV k="dbtype / fieldType" v={`${selectedAttr.dbType || "—"} / ${selectedAttr.fieldType || "—"}`} />
                    <KV k="precision" v={selectedAttr.precision == null ? "—" : String(selectedAttr.precision)} />
                    <KV k="defaultValue" v={selectedAttr.defaultValue || "—"} />
                    <KV k="refModelName" v={selectedAttr.refModel || "—"} />
                    <KV k="refTarget" v={selectedAttr.refTarget || "—"} />
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      <MetaEnumRelationSection detail={detail} onEdited={reload} />

      {detail.unknownTags.length > 0 && (
        <p className="meta-note">
          未识别的顶层节点：{detail.unknownTags.join("、")}（解析器会原样保留字节，不参与校验）
        </p>
      )}

      {editTarget && (
        <MetaEditDialog
          path={detail.path}
          sha={detail.sha256}
          entity={editTarget.entity}
          attr={editTarget.attr}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            onEdited();
          }}
          onReload={() => {
            setEditTarget(null);
            onEdited();
          }}
        />
      )}

      {entityTarget && (
        <MetaEntityDialog
          path={detail.path}
          sha={detail.sha256}
          entity={entityTarget.entity}
          onClose={() => setEntityTarget(null)}
          onSaved={() => {
            setEntityTarget(null);
            onEdited();
          }}
          onReload={() => {
            setEntityTarget(null);
            onEdited();
          }}
        />
      )}

      {copyOpen && (
        <MetaCopyEntityDialog
          path={detail.path}
          sha={detail.sha256}
          detail={detail}
          onClose={() => setCopyOpen(false)}
          onSaved={() => {
            setCopyOpen(false);
            onEdited();
          }}
          onReload={() => {
            setCopyOpen(false);
            onEdited();
          }}
        />
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="meta-kv">
      <span>{k}</span>
      <code>{v}</code>
    </div>
  );
}

function shortAccessor(s: string) {
  if (!s) return "—";
  const parts = s.split(".");
  return parts[parts.length - 1];
}
