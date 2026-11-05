import { edgeGeometry, type NodeBox } from "./canvasLayout";

/** 一条关系连线。两端落点由 layout 计算：有字段落到字段行，否则落节点边框。 */
export function MetaCanvasEdge({
  id,
  label,
  from,
  to,
  markerId,
  active,
  onSelect,
}: {
  id: string;
  label: string;
  from: NodeBox;
  to: NodeBox;
  markerId: string;
  active: boolean;
  onSelect: () => void;
}) {
  const g = edgeGeometry(from, to);
  return (
    <g
      className={`meta-canvas-rel ${g.field ? "is-field" : ""} ${active ? "is-active" : ""}`}
      data-rel={id}
      onClick={onSelect}
    >
      <path d={g.d} markerEnd={`url(#${markerId})`} fill="none" />
      <text x={g.mid.x} y={g.mid.y - 6} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}
