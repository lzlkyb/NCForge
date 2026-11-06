import type { BmfDetail, BmfEntity } from "../../lib/bmf";

export const KIND_SHORT: Record<string, string> = {
  AggregationRelation: "聚合",
  Reference: "引用",
  relation: "参照关联",
  busiitfconnection: "实现接口",
  ExtendConnection: "继承",
};

export const kindLabel = (kind: string) => KIND_SHORT[kind] ?? kind;

const attrName = (e: BmfEntity | undefined, attrId: string) =>
  e?.attrs.find((a) => a.id === attrId)?.name ?? "";

/** 关系方向 + 可选字段端点，例如「H.h1 → H2.fk（聚合）」。 */
export function relationText(detail: BmfDetail, relId: string): string {
  const r = detail.relations.find((x) => x.id === relId);
  if (!r) return "";
  const src = detail.entities.find((e) => e.id === r.source);
  const tgt = detail.entities.find((e) => e.id === r.target);
  const sa = attrName(src, r.srcAttrId);
  const ta = attrName(tgt, r.targetAttrId);
  const left = `${src?.name ?? r.source}${sa ? `.${sa}` : ""}`;
  const right = `${tgt?.name ?? r.target}${ta ? `.${ta}` : ""}`;
  return `${left} → ${right}（${kindLabel(r.kind)}）`;
}

/** 画布下半部分：实体清单 / 选中实体信息 / 关系清单。 */
export function MetaCanvasInfo({
  detail,
  current,
  relId,
  onPick,
  onPickRelation,
}: {
  detail: BmfDetail;
  current: BmfEntity | null;
  relId: string | null;
  onPick: (id: string) => void;
  onPickRelation: (id: string) => void;
}) {
  const related = current
    ? detail.relations.filter((r) => r.source === current.id || r.target === current.id)
    : [];

  return (
    <div className="meta-canvas-info">
      <div>
        <h4>实体</h4>
        <div className="meta-canvas-chips">
          {detail.entities.map((e) => (
            <button
              key={e.id}
              type="button"
              className={current?.id === e.id ? "is-active" : ""}
              onClick={() => onPick(e.id)}
            >
              {e.name}
            </button>
          ))}
        </div>
      </div>
      <div>
        <h4>{current ? `${current.name} 的信息` : "关系"}</h4>
        {current ? (
          <div className="meta-canvas-detail">
            <p>
              <span>类</span> <code>{current.fullClass || "—"}</code>
            </p>
            <p>
              <span>表</span> <code>{current.table || "—"}</code>
            </p>
            <p>
              <span>主键</span>{" "}
              <code>{current.attrs.find((a) => a.id === current.keyAttrId)?.name ?? "未指向"}</code>
            </p>
            <p>
              <span>关联关系</span>{" "}
              {related.length === 0 ? "无" : related.map((r) => relationText(detail, r.id)).join("，")}
            </p>
          </div>
        ) : detail.relations.length === 0 ? (
          <p className="meta-note m-0">还没有关系。拖节点右侧圆点到另一个实体，或到「结构」页新增关系。</p>
        ) : (
          <div className="meta-canvas-chips">
            {detail.relations.map((r) => (
              <button
                key={r.id}
                type="button"
                className={relId === r.id ? "is-active" : ""}
                onClick={() => onPickRelation(r.id)}
              >
                {relationText(detail, r.id)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
