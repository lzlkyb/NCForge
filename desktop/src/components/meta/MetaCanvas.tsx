import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { BmfDetail } from "../../lib/bmf";
import { Icon } from "../ui/icon";
import { canvasLayout, hitNode, rowIndexOf, HEAD_H, NODE_W, type Pos } from "./canvasLayout";
import { MetaCanvasEdge } from "./MetaCanvasEdge";
import { MetaCanvasInfo, kindLabel } from "./MetaCanvasInfo";
import { MetaCanvasNode } from "./MetaCanvasNode";
import { MetaRelationDialog } from "./MetaRelationDialog";

type PointerState =
  | { mode: "move"; id: string; dx: number; dy: number }
  | { mode: "link"; from: string; x: number; y: number };

/**
 * 关系画布（M8）：实体方阵 + 关系连线 + 拖拽建关系。
 *
 * 拖节点移动、拖右侧把手连线；连线落下后在弹框里补关系类型，保存走与「结构」页
 * 完全相同的预览/SHA 校验写回。画布坐标只是本视图状态，不回写 BMF。
 *
 * 关系指定了字段就画到字段行；字段被行数上限截掉时退回节点边框，不隐藏关系。
 */
export function MetaCanvas({ detail, onEdited }: { detail: BmfDetail; onEdited?: () => void }) {
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [relId, setRelId] = useState<string | null>(null);
  const [pointer, setPointer] = useState<PointerState | null>(null);
  const [dialog, setDialog] = useState<{ source: string; target: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 保存后按两端找新关系高亮：弹框拿不到后端生成的 GUID，只能用端点回找。
  const pendingEdge = useRef<{ source: string; target: string } | null>(null);
  const markerId = useId().replace(/[:]/g, "");

  const layout = useMemo(() => canvasLayout(detail.entities, detail.relations), [detail.entities, detail.relations]);
  const indexOf = useMemo(() => {
    const m: Record<string, number> = {};
    detail.entities.forEach((e, i) => {
      m[e.id] = i;
      m[e.name] = i;
    });
    return m;
  }, [detail.entities]);
  const positions = useMemo(
    () => layout.pos.map((p, i) => moved[detail.entities[i].id] ?? p),
    [layout, moved, detail.entities],
  );
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  useEffect(() => {
    if (!pointer) return;
    const local = (e: PointerEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return null;
      const rect = wrap.getBoundingClientRect();
      return {
        x: e.clientX - rect.left + wrap.scrollLeft,
        y: e.clientY - rect.top + wrap.scrollTop,
      };
    };
    const move = (e: PointerEvent) => {
      const pt = local(e);
      if (!pt) return;
      if (pointer.mode === "move") {
        setMoved((prev) => ({ ...prev, [pointer.id]: { x: pt.x - pointer.dx, y: pt.y - pointer.dy } }));
      } else {
        setPointer((p) => (p && p.mode === "link" ? { ...p, x: pt.x, y: pt.y } : p));
      }
    };
    const up = (e: PointerEvent) => {
      if (pointer.mode === "link") {
        const pt = local(e);
        const hit = pt ? hitNode(positionsRef.current, layout.shapes, pt) : -1;
        const target = hit >= 0 ? detail.entities[hit] : null;
        if (target && target.id !== pointer.from) setDialog({ source: pointer.from, target: target.id });
      }
      setPointer(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [pointer, layout, detail.entities]);

  useEffect(() => {
    const p = pendingEdge.current;
    if (!p) return;
    // 取最后一条：同一对实体可能已有旧关系，新加的在末尾。
    const hit = [...detail.relations].reverse().find((r) => r.source === p.source && r.target === p.target);
    if (hit) {
      setRelId(hit.id);
      pendingEdge.current = null;
    }
  }, [detail.relations]);

  const startMove = (e: ReactPointerEvent<SVGGElement>, id: string) => {
    const wrap = wrapRef.current;
    const i = indexOf[id];
    if (!wrap || i === undefined) return;
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const p = positions[i];
    setPointer({
      mode: "move",
      id,
      dx: e.clientX - rect.left + wrap.scrollLeft - p.x,
      dy: e.clientY - rect.top + wrap.scrollTop - p.y,
    });
    setSelected(id);
  };

  const startLink = (e: ReactPointerEvent<SVGGElement>, id: string) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    setPointer({
      mode: "link",
      from: id,
      x: e.clientX - rect.left + wrap.scrollLeft,
      y: e.clientY - rect.top + wrap.scrollTop,
    });
    setSelected(id);
  };

  const current = selected ? detail.entities.find((e) => e.id === selected || e.name === selected) ?? null : null;
  const activeRel = relId ? detail.relations.find((r) => r.id === relId) ?? null : null;
  const activeAttr = (entityId: string) =>
    !activeRel
      ? null
      : activeRel.source === entityId
        ? activeRel.srcAttrId || null
        : activeRel.target === entityId
          ? activeRel.targetAttrId || null
          : null;

  if (detail.entities.length === 0) {
    return (
      <p className="meta-note">
        这个组件没有实体，没有可画的节点。纯枚举 / 纯接口组件属于正常形态。
      </p>
    );
  }

  const linkSource = pointer?.mode === "link" ? indexOf[pointer.from] : undefined;
  const linkStart =
    linkSource !== undefined
      ? { x: positions[linkSource].x + NODE_W, y: positions[linkSource].y + HEAD_H / 2 }
      : null;

  return (
    <div className="meta-canvas-view">
      <div className="meta-canvas-bar">
        <span className="meta-note m-0">
          {detail.entities.length} 实体 · {detail.relations.length} 关系 · 拖节点移动，拖右侧圆点建关系
        </span>
        <button
          type="button"
          className="meta-link"
          onClick={() => {
            setMoved({});
            setSelected(null);
            setRelId(null);
          }}
          disabled={Object.keys(moved).length === 0}
        >
          <Icon name="refresh" size={12} /> 重排
        </button>
      </div>

      <div className="meta-canvas-wrap" ref={wrapRef}>
        <svg
          className="meta-canvas"
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label="实体关系画布"
        >
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L10 5 L0 10 z" className="meta-canvas-arrow" />
            </marker>
          </defs>

          {detail.relations.map((r) => {
            const ia = indexOf[r.source];
            const ib = indexOf[r.target];
            if (ia === undefined || ib === undefined) return null;
            return (
              <MetaCanvasEdge
                key={r.id}
                id={r.id}
                label={r.name || kindLabel(r.kind)}
                from={{
                  pos: positions[ia],
                  height: layout.shapes[ia].height,
                  row: rowIndexOf(layout.shapes[ia], r.srcAttrId),
                }}
                to={{
                  pos: positions[ib],
                  height: layout.shapes[ib].height,
                  row: rowIndexOf(layout.shapes[ib], r.targetAttrId),
                }}
                markerId={markerId}
                active={relId === r.id}
                onSelect={() => {
                  setRelId(r.id);
                  setSelected(r.source);
                }}
              />
            );
          })}

          {pointer?.mode === "link" && linkStart && (
            <line className="meta-canvas-link" x1={linkStart.x} y1={linkStart.y} x2={pointer.x} y2={pointer.y} />
          )}

          {detail.entities.map((e, i) => (
            <MetaCanvasNode
              key={e.id}
              entity={e}
              shape={layout.shapes[i]}
              pos={positions[i]}
              active={current?.id === e.id}
              activeAttrId={activeAttr(e.id)}
              onMoveStart={startMove}
              onLinkStart={startLink}
            />
          ))}
        </svg>
      </div>

      <MetaCanvasInfo
        detail={detail}
        current={current}
        relId={relId}
        onPick={(id) => setSelected(id)}
        onPickRelation={(id) => {
          setRelId(id);
          const r = detail.relations.find((x) => x.id === id);
          if (r) setSelected(r.source);
        }}
      />

      {dialog && (
        <MetaRelationDialog
          path={detail.path}
          sha={detail.sha256}
          detail={detail}
          initial={dialog}
          onClose={() => setDialog(null)}
          onSaved={() => {
            pendingEdge.current = dialog;
            setDialog(null);
            onEdited?.();
          }}
          onReload={() => {
            setDialog(null);
            onEdited?.();
          }}
        />
      )}
    </div>
  );
}
