export function selectionBounds(order: number[], visible: number[], selection: { anchor: {r:number;c:number}; end: {r:number;c:number} } | null) {
  if (!selection) return null;
  const a = order.indexOf(selection.anchor.r), b = order.indexOf(selection.end.r);
  const c = visible.indexOf(selection.anchor.c), d = visible.indexOf(selection.end.c);
  return Math.min(a,b,c,d) < 0 ? null : { rowStart: Math.min(a,b), rowEnd: Math.max(a,b), colStart: Math.min(c,d), colEnd: Math.max(c,d) };
}
export function columnViewport(visible: number[], widths: number[], frozen: Set<number>, left: number, width: number, rowWidth: number) {
  let offset = rowWidth, frozenOffset = rowWidth;
  return visible.map((column, index) => {
    const item = { column, index, left: offset, sticky: frozenOffset, width: widths[column], frozen: frozen.has(column) };
    offset += item.width;
    if (item.frozen) frozenOffset += item.width;
    return item;
  }).filter(c => c.frozen || c.left + c.width >= left - 200 && c.left <= left + width + 200);
}
