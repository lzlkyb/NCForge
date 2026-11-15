export interface ScrollViewport { top: number; left?: number; height: number; width?: number; }

/** Keep the mounted window while the live viewport remains inside its overscan safety margin. */
export function retainViewport<T extends ScrollViewport>(previous: T, next: T, padY: number, padX = 0): T {
  return previous.height === next.height && previous.width === next.width &&
    Math.abs(previous.top - next.top) <= padY / 2 &&
    Math.abs((previous.left ?? 0) - (next.left ?? 0)) <= padX / 2 ? previous : next;
}

/** Both fixed and wrapped lists use binary search, independent of the full record count. */
export function visibleRange(rows: readonly { top: number; height: number }[], top: number, height: number, padding: number) {
  const lower = (position: number) => {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].top + rows[mid].height <= position) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return { first: lower(Math.max(0, top - padding)), last: Math.min(rows.length, lower(top + height + padding) + 1) };
}
