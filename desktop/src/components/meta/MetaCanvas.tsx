import { spatialIndex } from "../../lib/spatialIndex";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BmfDetail } from "../../lib/bmf";
import { canvasObjects, canvasSelection, canvasSelectionId } from "../../lib/metaCanvasModel";
import { newMetaEditorState, selectedMetaEntity, type MetaCanvasState, type MetaSelection } from "../../lib/metaEditor";
import { useMetaCanvasPointer } from "../../hooks/useMetaCanvasPointer";
import { Icon } from "../ui/icon";
import { canvasLayout, visibleAttrs, rowIndexOf, HEAD_H, ROW_H, ROW_PAD, NODE_W, PAD, type Pos } from "./canvasLayout";
import { MetaCanvasEdge } from "./MetaCanvasEdge";
import { MetaCanvasInfo, kindLabel } from "./MetaCanvasInfo";
import { MetaCanvasNode } from "./MetaCanvasNode";
import { MetaRelationDialog } from "./MetaRelationDialog";

/** 联动画布和独立画布共用真实 BMF；坐标、缩放与滚动从不进入写回操作。 */
export function MetaCanvas({ detail, onEdited, selection, onSelect, initialState, onStateChange, linked = false, locked = false, onCreateRelation }: {
  detail: BmfDetail; onEdited?: () => void; selection?: MetaSelection; onSelect?: (selection: MetaSelection) => void;
  initialState?: MetaCanvasState; onStateChange?: (state: MetaCanvasState) => void; linked?: boolean; locked?: boolean;
  onCreateRelation?: (source: string, target?: string) => void;
}) {
  const [view, setView] = useState(() => initialState ?? newMetaEditorState().canvas);
  const [localSelection, setLocalSelection] = useState<MetaSelection>({ kind: "component" });
  const [dialog, setDialog] = useState<{ source: string; target: string } | null>(null);
  const [viewport, setViewport] = useState({ width: 600, height: 320 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(view);
  const initialRef = useRef(initialState);
  const callbacks = useRef({ onSelect, onStateChange, onCreateRelation, locked });
  callbacks.current = { onSelect, onStateChange, onCreateRelation, locked };
  const pendingEdge = useRef<{ source: string; target: string } | null>(null);
  const markerId = useId().replace(/:/g, "");
  const active = selection ?? localSelection;
  const objects = useMemo(() => canvasObjects(detail), [detail]);
  const current = selectedMetaEntity(detail, active);
  const activeRel = active.kind === "relation" ? detail.relations.find((r) => r.id === active.relationId) : null;
  const selectedAttrs = useMemo(() => {
    const map: Record<string, string> = {};
    if (active.kind === "attr") map[active.entityId] = active.attrId;
    if (active.kind === "interfaceAttr") map[active.interfaceId] = active.attrId;
    if (activeRel) { map[activeRel.source] = activeRel.srcAttrId; map[activeRel.target] = activeRel.targetAttrId; }
    return map;
  }, [active, activeRel]);
  const layout = useMemo(() => canvasLayout(objects, detail.relations), [objects, detail.relations]);
  const shapes = useMemo(() => layout.shapes.map((shape, index) => {
    const entity = objects[index];
    const id = selectedAttrs[entity.id] || selectedAttrs[entity.name];
    if (!id || shape.rows.some((a) => a.id === id)) return shape;
    const rows = visibleAttrs(entity, detail.relations, id);
    return { rows, height: HEAD_H + rows.length * ROW_H + ROW_PAD };
  }), [layout.shapes, selectedAttrs, objects, detail.relations]);
  const positions = useMemo(() => layout.pos.map((pos, i) => view.moved[objects[i].id] ?? pos), [layout.pos, view.moved, objects]);
  const indexOf = useMemo(() => {
    const map: Record<string, number> = {};
    objects.forEach((e, i) => { map[e.id] = i; map[e.name] = i; });
    return map;
  }, [objects]);
  const nodeIndex = useMemo(() => spatialIndex(positions.map((p, id) => ({ id, left: p.x, top: p.y, right: p.x + NODE_W, bottom: p.y + shapes[id].height }))), [positions, shapes]);
  const edgeIndex = useMemo(() => spatialIndex(detail.relations.flatMap((r, id) => {
    const a = positions[indexOf[r.source]], b = positions[indexOf[r.target]];
    return a && b ? [{ id, left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x) + NODE_W, bottom: Math.max(a.y + shapes[indexOf[r.source]].height, b.y + shapes[indexOf[r.target]].height) }] : [];
  })), [detail.relations, positions, indexOf, shapes]);
  const extent = useMemo(() => ({
    width: positions.reduce((max, pos) => Math.max(max, pos.x + NODE_W + PAD), layout.width),
    height: positions.reduce((max, pos, i) => Math.max(max, pos.y + shapes[i].height + PAD), layout.height),
  }), [positions, shapes, layout.width, layout.height]);
  const geometry = useRef({ positions, indexOf, objects });
  geometry.current = { positions, indexOf, objects };
  const remember = useCallback((patch: Partial<MetaCanvasState>, render = true) => {
    stateRef.current = { ...stateRef.current, ...patch };
    if (render) setView(stateRef.current);
    callbacks.current.onStateChange?.(stateRef.current);
  }, []);
  const select = useCallback((next: MetaSelection) => {
    if (callbacks.current.locked) return;
    setLocalSelection(next);
    callbacks.current.onSelect?.(next);
  }, []);
  const selectEntity = useCallback((id: string) => { const object = geometry.current.objects[geometry.current.indexOf[id]]; if (object) select(canvasSelection(object)); }, [select]);
  const selectAttr = useCallback((entityId: string, attrId: string) => { const object = geometry.current.objects[geometry.current.indexOf[entityId]]; if (object) select(canvasSelection(object, attrId)); }, [select]);
  const selectRelation = useCallback((relationId: string) => select({ kind: "relation", relationId }), [select]);
  const move = useCallback((id: string, pos: Pos) => remember({ moved: { ...stateRef.current.moved, [id]: pos } }), [remember]);
  const nudge = useCallback((id: string, dx: number, dy: number) => {
    if (callbacks.current.locked) return;
    const pos = geometry.current.positions[geometry.current.indexOf[id]];
    if (!pos) return;
    selectEntity(id);
    move(id, { x: Math.max(0, pos.x + dx), y: Math.max(0, pos.y + dy) });
  }, [move, selectEntity]);
  const link = useCallback((source: string, target?: string) => {
    if (callbacks.current.locked) return;
    if (callbacks.current.onCreateRelation) callbacks.current.onCreateRelation(source, target);
    else setDialog({ source, target: target ?? "" });
  }, []);
  const createLink = useCallback((id: string) => link(id), [link]);
  const { pointer, startMove, startLink } = useMetaCanvasPointer({
    wrapRef, positions, shapes, ids: objects.map((e) => e.id), zoom: view.zoom,
    enabled: !locked, onMove: move, onSelect: selectEntity, onLink: link,
  });
  useLayoutEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    node.scrollLeft = initialRef.current?.left ?? 0;
    node.scrollTop = initialRef.current?.top ?? 0;
    const measure = () => setViewport({ width: node.clientWidth || 600, height: node.clientHeight || 320 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [detail.path]);
  useEffect(() => {
    const pending = pendingEdge.current;
    if (!pending) return;
    const hit = [...detail.relations].reverse().find((r) => r.source === pending.source && r.target === pending.target);
    if (hit) { selectRelation(hit.id); pendingEdge.current = null; }
  }, [detail.relations, selectRelation]);

  const selectedId = canvasSelectionId(active) ?? current?.id ?? null;
  const bounds = { left: view.left / view.zoom - 300, top: view.top / view.zoom - 220, right: (view.left + viewport.width) / view.zoom + 300, bottom: (view.top + viewport.height) / view.zoom + 220 };
  const visible = objects.length > 100 ? nodeIndex(bounds) : new Set(objects.map((_, i) => i));
  if (selectedId && indexOf[selectedId] !== undefined) visible.add(indexOf[selectedId]);
  const visibleEdges = edgeIndex(bounds);
  if (activeRel) visibleEdges.add(detail.relations.indexOf(activeRel));
  if (!objects.length) return <p className="meta-note meta-canvas-empty">这个组件没有可绘制的实体、接口或参照；可以在下方查看枚举。</p>;
  const { width, height } = extent;
  const zoomTo = (zoom: number) => remember({ zoom: Math.max(0.4, Math.min(1.8, Math.round(zoom * 100) / 100)) });
  const locate = () => {
    const node = wrapRef.current;
    const pos = selectedId ? positions[indexOf[selectedId]] : null;
    if (!node || !pos) return;
    node.scrollLeft = Math.max(0, pos.x * view.zoom - (node.clientWidth - NODE_W * view.zoom) / 2);
    node.scrollTop = Math.max(0, pos.y * view.zoom - 24);
    remember({ left: node.scrollLeft, top: node.scrollTop }, false);
  };
  const linkIndex = pointer?.mode === "link" ? indexOf[pointer.from] : undefined;
  const linkStart = linkIndex === undefined ? null : { x: positions[linkIndex].x + NODE_W, y: positions[linkIndex].y + HEAD_H / 2 };
  return <div className={`meta-canvas-view ${linked ? "is-linked" : ""}`}>
    <div className="meta-canvas-bar"><span className="meta-note m-0">{detail.entities.length} 实体 · {detail.relations.length} 关系</span>
      <div className="meta-canvas-tools">
        <button type="button" className="meta-link" disabled={locked || !detail.entities.length} onClick={() => { const source = current?.id ?? detail.entities[0]?.id; if (source) link(source); }}><Icon name="plus" size={12} />关系</button>
        <button type="button" className="meta-icon-button" aria-label="缩小模型" onClick={() => zoomTo(view.zoom - 0.1)}><Icon name="minimize" size={12} /></button>
        <button type="button" className="meta-link meta-zoom-value" onClick={() => zoomTo(1)} aria-label="恢复 100% 缩放">{Math.round(view.zoom * 100)}%</button>
        <button type="button" className="meta-icon-button" aria-label="放大模型" onClick={() => zoomTo(view.zoom + 0.1)}><Icon name="plus" size={12} /></button>
        <button type="button" className="meta-link" onClick={() => {
          const node = wrapRef.current;
          if (node) { zoomTo(Math.min(node.clientWidth / width, node.clientHeight / height, 1)); node.scrollTop = 0; node.scrollLeft = 0; remember({ top: 0, left: 0 }, false); }
        }}>适配</button>
        <button type="button" className="meta-link" onClick={locate} disabled={!selectedId}>定位</button>
        <button type="button" className="meta-link" onClick={() => remember({ moved: {} })} disabled={!Object.keys(view.moved).length}><Icon name="refresh" size={12} />重排</button>
      </div>
    </div>
    <div className="meta-canvas-wrap" ref={wrapRef} onScroll={(e) => remember({ left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop }, objects.length > 100)}>
      <svg className="meta-canvas" width={width * view.zoom} height={height * view.zoom} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="实体关系画布">
        <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" className="meta-canvas-arrow" /></marker></defs>
        {[...visibleEdges].map((edgeId) => {
          const r = detail.relations[edgeId];
          const a = indexOf[r.source], b = indexOf[r.target];
          const inView = a !== undefined && b !== undefined && (visible.has(a) || visible.has(b) || activeRel?.id === r.id
            || (Math.min(positions[a].x, positions[b].x) * view.zoom <= view.left + viewport.width && Math.max(positions[a].x, positions[b].x) * view.zoom >= view.left
              && Math.min(positions[a].y, positions[b].y) * view.zoom <= view.top + viewport.height && Math.max(positions[a].y, positions[b].y) * view.zoom >= view.top));
          return !inView ? null : <MetaCanvasEdge key={r.id} id={r.id} label={`${r.displayName || r.name || kindLabel(r.kind)}${r.sourceConstraint || r.targetConstraint ? ` · ${r.sourceConstraint || "?"}:${r.targetConstraint || "?"}` : ""}`}
            from={{ pos: positions[a], height: shapes[a].height, row: rowIndexOf(shapes[a], r.srcAttrId) }}
            to={{ pos: positions[b], height: shapes[b].height, row: rowIndexOf(shapes[b], r.targetAttrId) }}
            markerId={markerId} active={activeRel?.id === r.id} locked={locked} onSelect={selectRelation} />;
        })}
        {pointer?.mode === "link" && linkStart && <line className="meta-canvas-link" x1={linkStart.x} y1={linkStart.y} x2={pointer.x} y2={pointer.y} />}
        {[...visible].map((index) => { const entity = objects[index]; return <MetaCanvasNode key={entity.id} entity={entity} shape={shapes[index]} pos={positions[index]}
          active={active.kind !== "component" && (selectedId === entity.id || activeRel?.source === entity.id || activeRel?.target === entity.id || activeRel?.target === entity.name)} activeAttrId={selectedAttrs[entity.id] || selectedAttrs[entity.name] || null} locked={locked}
          onMoveStart={startMove} onLinkStart={startLink} onSelect={selectEntity} onSelectAttr={selectAttr} onNudge={nudge} onCreateLink={createLink} />; })}
      </svg>
    </div>
    {!linked && <MetaCanvasInfo detail={detail} current={active.kind === "component" ? null : current ?? null} relId={activeRel?.id ?? null} onPick={selectEntity} onPickRelation={selectRelation} />}
    {dialog && <MetaRelationDialog path={detail.path} sha={detail.sha256} detail={detail} initial={dialog}
      onClose={() => setDialog(null)} onSaved={() => { pendingEdge.current = dialog; setDialog(null); onEdited?.(); }}
      onReload={() => { setDialog(null); onEdited?.(); }} />}
  </div>;
}
