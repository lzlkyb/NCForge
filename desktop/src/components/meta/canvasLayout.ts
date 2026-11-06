import type { BmfAttr, BmfEntity, BmfRelation } from "../../lib/bmf";

export const NODE_W = 244;
/** 节点头部：标题 + 类/表名 + 字段数。之后才是字段行。 */
export const HEAD_H = 72;
export const ROW_H = 22;
export const ROW_PAD = 6;
/** 每个节点最多显示几行字段；被截掉的字段靠信息面板看。 */
export const MAX_ROWS = 6;
export const GAP_X = 64;
export const GAP_Y = 52;
export const PAD = 28;

export interface Pos {
  x: number;
  y: number;
}

export interface NodeShape {
  height: number;
  rows: BmfAttr[];
}

export interface Layout {
  width: number;
  height: number;
  cols: number;
  pos: Pos[];
  shapes: NodeShape[];
}

/**
 * 节点里显示哪些字段：关系端点字段优先（否则连线没有行可落），
 * 其次主键，最后按声明顺序补满。超出上限的端点会退回节点边框连线。
 */
export function visibleAttrs(e: BmfEntity, relations: BmfRelation[], selectedId?: string): BmfAttr[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const take = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  for (const r of relations) {
    if (r.source === e.id) take(r.srcAttrId);
    if (r.target === e.id) take(r.targetAttrId);
  }
  take(e.keyAttrId);
  for (const a of e.attrs) {
    if (order.length >= MAX_ROWS) break;
    take(a.id);
  }
  const byId = new Map(e.attrs.map((a) => [a.id, a]));
  const rows = order
    .slice(0, MAX_ROWS)
    .map((id) => byId.get(id))
    .filter((a): a is BmfAttr => !!a);
  // 补入隐藏的选中字段，同时保留其他摘要行的相对顺序。
  const selected = selectedId ? byId.get(selectedId) : undefined;
  if (selected && !rows.some((a) => a.id === selected.id)) {
    if (rows.length >= MAX_ROWS) rows.pop();
    rows.push(selected);
  }
  return rows;
}

export function nodeShape(e: BmfEntity, relations: BmfRelation[]): NodeShape {
  const rows = visibleAttrs(e, relations);
  return { height: HEAD_H + rows.length * ROW_H + ROW_PAD, rows };
}

/** 确定性方阵布局：同一份 BMF 每次打开都得到同一块画布与同一组坐标。 */
export function canvasLayout(entities: BmfEntity[], relations: BmfRelation[]): Layout {
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(entities.length))));
  const shapes = entities.map((e) => nodeShape(e, relations));
  const rowCount = Math.max(1, Math.ceil(entities.length / cols));
  const rowHeights: number[] = [];
  for (let r = 0; r < rowCount; r++) {
    let h = 0;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i < entities.length) h = Math.max(h, shapes[i].height);
    }
    rowHeights.push(h);
  }
  const pos: Pos[] = [];
  let y = PAD;
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i < entities.length) pos[i] = { x: PAD + c * (NODE_W + GAP_X), y };
    }
    y += rowHeights[r] + GAP_Y;
  }
  return {
    width: PAD * 2 + cols * NODE_W + (cols - 1) * GAP_X,
    height: PAD * 2 + rowHeights.reduce((a, b) => a + b, 0) + (rowCount - 1) * GAP_Y,
    cols,
    pos,
    shapes,
  };
}

/** 字段行中心距节点顶部的偏移。 */
export const rowOffset = (row: number) => HEAD_H + row * ROW_H + ROW_H / 2;

export function rowIndexOf(shape: NodeShape, attrId: string): number {
  return attrId ? shape.rows.findIndex((a) => a.id === attrId) : -1;
}

export interface NodeBox {
  pos: Pos;
  height: number;
  /** -1 = 连到节点边框（关系没指定这一端的字段，或字段被截断）。 */
  row: number;
}

/** 椭圆近似求交：箭头端点落在节点边框外，不会被节点盖住。 */
function ellipseHit(cx: number, cy: number, tx: number, ty: number, h: number): Pos {
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy) || 1;
  const rx = NODE_W / 2 + 6;
  const ry = h / 2 + 6;
  const t = 1 / Math.sqrt((dx / (len * rx)) ** 2 + (dy / (len * ry)) ** 2);
  return { x: cx + (dx / len) * t, y: cy + (dy / len) * t };
}

function straight(a: NodeBox, b: NodeBox) {
  const ac = { x: a.pos.x + NODE_W / 2, y: a.pos.y + a.height / 2 };
  const bc = { x: b.pos.x + NODE_W / 2, y: b.pos.y + b.height / 2 };
  const p1 = ellipseHit(ac.x, ac.y, bc.x, bc.y, a.height);
  const p2 = ellipseHit(bc.x, bc.y, ac.x, ac.y, b.height);
  return { d: `M${p1.x} ${p1.y} L${p2.x} ${p2.y}`, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
}

/**
 * 关系连线路径。两端都指定了字段时落到字段行，用三次曲线从侧边出入；
 * 否则退回节点边框直线——保证老关系（无属性）仍然可见。
 */
export function edgeGeometry(a: NodeBox, b: NodeBox): { d: string; mid: Pos; field: boolean } {
  if (a.row < 0 || b.row < 0) {
    const s = straight(a, b);
    return { ...s, field: false };
  }
  const rightward = b.pos.x + NODE_W / 2 >= a.pos.x + NODE_W / 2;
  const x1 = a.pos.x + (rightward ? NODE_W : 0);
  const y1 = a.pos.y + rowOffset(a.row);
  const x2 = b.pos.x + (rightward ? 0 : NODE_W);
  const y2 = b.pos.y + rowOffset(b.row);
  const mx = (x1 + x2) / 2;
  return {
    d: `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
    mid: { x: mx, y: (y1 + y2) / 2 },
    field: true,
  };
}

/** 命中测试：给拖拽建关系找落点。后画的节点在上层，所以从后往前找。 */
export function hitNode(pos: Pos[], shapes: NodeShape[], pt: Pos, pad = 6): number {
  for (let i = pos.length - 1; i >= 0; i--) {
    const p = pos[i];
    if (!p) continue;
    const h = shapes[i].height;
    if (pt.x >= p.x - pad && pt.x <= p.x + NODE_W + pad && pt.y >= p.y - pad && pt.y <= p.y + h + pad) {
      return i;
    }
  }
  return -1;
}

/** 字段行上显示的类型标签；太长截断，避免压到字段名。 */
export function typeLabel(a: BmfAttr): string {
  const t = a.typeName || a.dbType || a.dataType || "";
  return t.length > 10 ? `${t.slice(0, 9)}…` : t;
}
