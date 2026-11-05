import type { DiffKind, DiffRow } from "../../lib/bmfDiff";

const KIND_LABEL: Record<DiffKind, string> = {
  component: "组件",
  entity: "实体",
  attr: "字段",
  enum: "枚举",
  enumItem: "枚举项",
  relation: "关系",
};

const CHANGE_LABEL = { added: "新增", removed: "删除", changed: "变更" } as const;

/** 结构差异表：对比页与历史页共用同一套行，避免两处口径漂移。 */
export function MetaDiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="meta-compare-rows">
      {rows.map((r, i) => (
        <div key={`${r.kind}-${r.scope}-${r.field}-${i}`} className={`meta-compare-row is-${r.change}`}>
          <span className="meta-compare-badge">{CHANGE_LABEL[r.change]}</span>
          <span className="meta-compare-kind">{KIND_LABEL[r.kind]}</span>
          <span className="meta-compare-scope">{r.scope}</span>
          <span className="meta-compare-field">{r.field}</span>
          <span className="meta-compare-values">
            {r.change !== "added" && <code>{r.before || "—"}</code>}
            {r.change === "changed" && <span className="meta-compare-arrow">→</span>}
            {r.change !== "removed" && <code>{r.after || "—"}</code>}
          </span>
        </div>
      ))}
    </div>
  );
}
