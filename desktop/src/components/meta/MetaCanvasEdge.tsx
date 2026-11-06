import { memo } from "react";
import { edgeGeometry, type NodeBox } from "./canvasLayout";

/** 一条关系连线。两端落点由 layout 计算：有字段落到字段行，否则落节点边框。 */
export const MetaCanvasEdge = memo(function MetaCanvasEdge({
  id,
  label,
  from,
  to,
  markerId,
  active,
  onSelect,
  locked,
}: {
  id: string;
  label: string;
  from: NodeBox;
  to: NodeBox;
  markerId: string;
  active: boolean;
  onSelect: (id: string) => void;
  locked: boolean;
}) {
  const g = edgeGeometry(from, to);
  return (
    <g
      className={`meta-canvas-rel ${g.field ? "is-field" : ""} ${active ? "is-active" : ""}`}
      data-rel={id}
      role="button" tabIndex={locked ? -1 : 0} aria-label={`关系 ${label}`} aria-pressed={active}
      onClick={() => { if (!locked) onSelect(id); }}
      onKeyDown={(e) => { if (!locked && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(id); } }}
    >
      <path className="meta-edge-hit" d={g.d} fill="none" />
      <path d={g.d} markerEnd={`url(#${markerId})`} fill="none" />
      <text x={g.mid.x} y={g.mid.y - 6} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}, (prev, next) => prev.id === next.id && prev.label === next.label && prev.markerId === next.markerId && prev.active === next.active && prev.locked === next.locked && prev.onSelect === next.onSelect &&
  prev.from.pos === next.from.pos && prev.to.pos === next.to.pos && prev.from.height === next.from.height && prev.to.height === next.to.height && prev.from.row === next.from.row && prev.to.row === next.to.row);
