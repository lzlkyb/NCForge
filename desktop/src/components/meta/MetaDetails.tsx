import { useMemo, useState } from "react";
import type { BmfAttr, BmfDetail, BmfEntity } from "../../lib/bmf";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { MetaEditDialog } from "./MetaEditDialog";

/** 概览 + 实体字段 + 枚举关系。只负责看清结构；改字段走 MetaEditDialog（预览 diff 后才落盘）。 */
export function MetaDetails({
  detail,
  onEdited,
}: {
  detail: BmfDetail;
  onEdited: () => void;
}) {
  const [entityId, setEntityId] = useState(() => detail.entities[0]?.id ?? "");
  const [attrSearch, setAttrSearch] = useState("");
  const [selectedAttr, setSelectedAttr] = useState<BmfAttr | null>(null);
  const [editTarget, setEditTarget] = useState<{ attr: BmfAttr | null; entity: BmfEntity } | null>(null);

  const entity = detail.entities.find((e) => e.id === entityId) ?? detail.entities[0];

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

  return (
    <div className="meta-detail-body">
      <section className="meta-overview">
        <Info label="组件" value={`${detail.component.name} · ${detail.component.displayName || "—"}`} />
        <Info label="命名空间" value={detail.component.namespace || "—"} />
        <Info label="所属模块" value={detail.component.ownModule || "—"} />
        <Info label="版本 / 风格" value={`v${detail.component.version} · ${detail.component.genCodeStyle || "未声明"}`} />
        <Info
          label="文件"
          value={`${detail.encoding} ${detail.eol}${detail.bom ? " · BOM" : ""} · ${(detail.size / 1024).toFixed(1)} KB`}
          mono
        />
        <Info label="SHA-256" value={detail.sha256.slice(0, 16)} mono title={detail.sha256} />
      </section>

      {detail.entities.length === 0 ? (
        <p className="meta-note">这个组件没有实体（纯枚举 / 纯接口 / 历史残留都是合法形态，不一定是解析失败）。</p>
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
                  setSelectedAttr(null);
                }}
              >
                <span>{e.name}</span>
                <span className="meta-entity-meta">
                  {e.table || "无表名"} · {e.attrs.length}
                </span>
                {e.isPrimary && <span className="meta-pk-badge">主</span>}
              </button>
            ))}
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
                      className="h-6 border-0 bg-transparent px-1 text-[12px] focus-visible:ring-0"
                    />
                  </div>
                  <button type="button" className="meta-link" onClick={() => setEditTarget({ attr: null, entity })}>
                    <Icon name="plus" size={12} /> 加字段
                  </button>
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
                    className={`meta-attr-row ${selectedAttr?.id === a.id ? "is-active" : ""}`}
                    onClick={() => setSelectedAttr(a)}
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
                <div className="meta-inspector">
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
                      <button type="button" className="meta-link" onClick={() => setSelectedAttr(null)}>
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

      <section className="meta-two-col">
        <div>
          <h4 className="meta-section-title">枚举（{detail.enums.length}）</h4>
          {detail.enums.length === 0 && <p className="meta-note">没有枚举定义。</p>}
          {detail.enums.map((en) => (
            <div key={en.id} className="meta-enum">
              <div className="meta-enum-head">
                <span className="font-medium">{en.name}</span>
                <span className="text-muted-foreground">
                  {en.displayName || "—"} · {en.items.length} 项
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
          <h4 className="meta-section-title">关系（{detail.relations.length}）</h4>
          {detail.relations.length === 0 && <p className="meta-note">没有连接关系。</p>}
          {detail.relations.map((r) => (
            <div key={r.id} className="meta-relation">
              <div className="font-medium">{r.kind}</div>
              <div className="text-muted-foreground">
                {r.source} → {r.target}
                {r.srcAttrId ? `（${r.srcAttrId} → ${r.targetAttrId}）` : ""}
              </div>
            </div>
          ))}
        </div>
      </section>

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
        />
      )}
    </div>
  );
}

function Info({ label, value, mono, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="meta-info" title={title}>
      <span>{label}</span>
      <strong className={mono ? "meta-mono" : ""}>{value}</strong>
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
