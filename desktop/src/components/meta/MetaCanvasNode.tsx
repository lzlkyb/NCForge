import type { PointerEvent as ReactPointerEvent } from "react";
import type { BmfEntity } from "../../lib/bmf";
import { HEAD_H, NODE_W, ROW_H, typeLabel, type NodeShape, type Pos } from "./canvasLayout";

/**
 * 画布节点：头部三行摘要 + 字段行 + 右侧拖拽建关系的把手。
 *
 * 拖动节点本体 = 移动；拖动把手 = 拉一条关系。两者分开，
 * 否则「想把节点拖开一点」会频繁误弹新建关系框。
 */
export function MetaCanvasNode({
  entity,
  shape,
  pos,
  active,
  activeAttrId,
  onMoveStart,
  onLinkStart,
}: {
  entity: BmfEntity;
  shape: NodeShape;
  pos: Pos;
  active: boolean;
  activeAttrId: string | null;
  onMoveStart: (e: ReactPointerEvent<SVGGElement>, id: string) => void;
  onLinkStart: (e: ReactPointerEvent<SVGGElement>, id: string) => void;
}) {
  const hidden = entity.attrs.length - shape.rows.length;
  return (
    <g
      className={`meta-canvas-node ${active ? "is-active" : ""}`}
      transform={`translate(${pos.x} ${pos.y})`}
      onPointerDown={(ev) => onMoveStart(ev, entity.id)}
      role="button"
      aria-label={`实体 ${entity.name}`}
    >
      <rect width={NODE_W} height={shape.height} rx={8} />
      <text className="meta-canvas-title" x={12} y={22}>
        {entity.displayName || entity.name}
        {entity.isPrimary && " ★"}
      </text>
      <text className="meta-canvas-sub" x={12} y={39}>
        {entity.name} · {entity.table || "无表名"}
      </text>
      <text className="meta-canvas-sub" x={12} y={56}>
        {entity.attrs.length} 字段
        {hidden > 0 ? ` · 显示 ${shape.rows.length}` : ""}
        {entity.accessor ? " · 有访问器" : ""}
      </text>
      <line className="meta-canvas-divider" x1={0} y1={HEAD_H} x2={NODE_W} y2={HEAD_H} />
      {shape.rows.map((a, i) => (
        <g
          key={a.id}
          className={`meta-canvas-field ${a.isKey ? "is-key" : ""} ${activeAttrId === a.id ? "is-active" : ""}`}
        >
          <text x={12} y={HEAD_H + i * ROW_H + 12}>
            {a.isKey ? "★ " : ""}
            {a.name}
          </text>
          <text className="meta-canvas-field-type" x={NODE_W - 12} y={HEAD_H + i * ROW_H + 12} textAnchor="end">
            {typeLabel(a)}
          </text>
        </g>
      ))}
      <g
        className="meta-canvas-handle"
        transform={`translate(${NODE_W} ${HEAD_H / 2})`}
        onPointerDown={(ev) => {
          ev.stopPropagation();
          onLinkStart(ev, entity.id);
        }}
        role="button"
        aria-label={`从 ${entity.name} 拖出关系`}
      >
        <circle r={7} />
        <path d="M-2 0 H3 M0 -3 L3 0 L0 3" />
      </g>
    </g>
  );
}
