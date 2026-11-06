import { memo, useId, type PointerEvent as ReactPointerEvent } from "react";
import type { MetaCanvasObject } from "../../lib/metaCanvasModel";
import { HEAD_H, NODE_W, ROW_H, typeLabel, type NodeShape, type Pos } from "./canvasLayout";

/** 字段单击只选择，实体头部拖动只调整视图位置；键盘提供同等入口。 */
export const MetaCanvasNode = memo(function MetaCanvasNode({ entity, shape, pos, active, activeAttrId, locked, onMoveStart, onLinkStart, onSelect, onSelectAttr, onNudge, onCreateLink }: {
  entity: MetaCanvasObject; shape: NodeShape; pos: Pos; active: boolean; activeAttrId: string | null; locked: boolean;
  onMoveStart: (e: ReactPointerEvent<SVGGElement>, id: string) => void;
  onLinkStart: (e: ReactPointerEvent<SVGGElement>, id: string) => void;
  onSelect: (id: string) => void; onSelectAttr: (entityId: string, attrId: string) => void;
  onNudge: (id: string, dx: number, dy: number) => void; onCreateLink: (id: string) => void;
}) {
  const clip = useId().replace(/:/g, "");
  const hidden = entity.attrs.length - shape.rows.length;
  const kind = entity.modelKind === "interface" ? "接口" : entity.modelKind === "reference" ? "参照" : "实体";
  return <g className={`meta-canvas-node ${active ? "is-active" : ""}`} data-entity={entity.id} data-kind={entity.modelKind || "entity"}
    transform={`translate(${pos.x} ${pos.y})`} onPointerDown={(ev) => onMoveStart(ev, entity.id)}
    role="button" tabIndex={locked ? -1 : 0} aria-pressed={active} aria-label={`${kind} ${entity.name}`}
    onKeyDown={(e) => {
      if (locked || e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(entity.id); }
      const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (steps[e.key]) { e.preventDefault(); const [dx, dy] = steps[e.key]; onNudge(entity.id, dx * (e.shiftKey ? 40 : 10), dy * (e.shiftKey ? 40 : 10)); }
    }}>
    <defs><clipPath id={`${clip}-title`}><rect x={8} y={4} width={NODE_W - 20} height={HEAD_H - 8} /></clipPath>
      <clipPath id={`${clip}-field`}><rect x={8} y={0} width={NODE_W - 98} height={shape.height} /></clipPath></defs>
    <rect className="meta-node-surface" width={NODE_W} height={shape.height} rx={6} />
    <g clipPath={`url(#${clip}-title)`}>
      <text className="meta-canvas-title" x={12} y={22}>{entity.displayName || entity.name}</text>
      <text className="meta-canvas-sub" x={12} y={40}>{entity.name} · {entity.modelKind ? kind : entity.table || "无表名"}</text>
      <text className="meta-canvas-sub" x={12} y={58}>{entity.modelKind === "reference" ? "外部模型 · 查看引用定义" : `${entity.attrs.length} ${entity.modelKind ? "属性" : "字段"}${hidden > 0 ? ` · 显示 ${shape.rows.length}` : ""}${entity.isPrimary ? " · 主实体" : ""}`}</text>
      <title>{entity.displayName || entity.name} · {entity.name} · {entity.table}</title>
    </g>
    <line className="meta-canvas-divider" x1={0} y1={HEAD_H} x2={NODE_W} y2={HEAD_H} />
    {shape.rows.map((attr, index) => <g key={attr.id} className={`meta-canvas-field ${attr.isKey ? "is-key" : ""} ${activeAttrId === attr.id ? "is-active" : ""}`}
      data-attr={attr.id} role="button" tabIndex={locked || activeAttrId !== attr.id ? -1 : 0} aria-label={`字段 ${attr.name}`} aria-pressed={activeAttrId === attr.id}
      onPointerDown={(e) => e.stopPropagation()} onClick={() => { if (!locked) onSelectAttr(entity.id, attr.id); }}
      onKeyDown={(e) => { if (!locked && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); onSelectAttr(entity.id, attr.id); } }}>
      <rect x={1} y={HEAD_H + index * ROW_H} width={NODE_W - 2} height={ROW_H} />
      <text clipPath={`url(#${clip}-field)`} x={12} y={HEAD_H + index * ROW_H + 15}>{attr.isKey ? "PK " : ""}{attr.name}</text>
      <text className="meta-canvas-field-type" x={NODE_W - 12} y={HEAD_H + index * ROW_H + 15} textAnchor="end">{typeLabel(attr)}</text>
      <title>{attr.displayName || attr.name} · {attr.typeName} · {attr.field || "无列映射"}</title>
    </g>)}
    {!entity.modelKind && <g className="meta-canvas-handle" transform={`translate(${NODE_W} ${HEAD_H / 2})`}
      onPointerDown={(e) => { e.stopPropagation(); onLinkStart(e, entity.id); }} role="button" tabIndex={locked ? -1 : 0}
      aria-label={`从 ${entity.name} 创建关系`} onKeyDown={(e) => { if (!locked && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); onCreateLink(entity.id); } }}>
      <circle r={8} /><path d="M-2 0 H3 M0 -3 L3 0 L0 3" />
    </g>}
  </g>;
});
