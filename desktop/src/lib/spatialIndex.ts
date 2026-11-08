export interface Bounds { left: number; top: number; right: number; bottom: number }
interface Entry extends Bounds { id: number }
interface Node extends Bounds { children?: Node[]; entries?: Entry[] }
/** Packed bounding-volume tree: viewport changes only visit intersecting branches. */
export function spatialIndex(entries: Entry[]) {
  function build(items: Entry[], depth = 0): Node {
    const bounds = items.reduce((b, e) => ({ left: Math.min(b.left, e.left), top: Math.min(b.top, e.top), right: Math.max(b.right, e.right), bottom: Math.max(b.bottom, e.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    if (items.length <= 16) return { ...bounds, entries: items };
    items.sort((a, b) => depth % 2 ? a.top - b.top : a.left - b.left);
    const mid = items.length >>> 1;
    return { ...bounds, children: [build(items.slice(0, mid), depth + 1), build(items.slice(mid), depth + 1)] };
  }
  const root = build([...entries]);
  const intersects = (a: Bounds, b: Bounds) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  return (viewport: Bounds) => {
    const found = new Set<number>();
    function visit(node: Node) {
      if (!intersects(node, viewport)) return;
      node.entries?.forEach(e => { if (intersects(e, viewport)) found.add(e.id); });
      node.children?.forEach(visit);
    }
    visit(root); return found;
  };
}
