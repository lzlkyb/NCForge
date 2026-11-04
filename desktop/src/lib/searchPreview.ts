import type { MatchRange } from "./search";

const PREVIEW_LENGTH = 80;
const LEADING_CONTEXT = 8;

/** 仅裁剪展示副本；原始 UTF-16 区间仍供编辑器定位与替换使用。 */
export function buildSearchPreview(text: string, ranges: MatchRange[]) {
  const first = ranges.find((r) => r.end > r.start && r.end > 0 && r.start < text.length);
  let start = Math.max(0, (first?.start ?? 0) - LEADING_CONTEXT);
  let end = Math.min(text.length, start + PREVIEW_LENGTH);
  // JS 下标是 UTF-16：窗口边界不能把 emoji 等代理对切成乱码。
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start -= 1;
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end += 1;
  const prefix = start > 0 ? "…" : "";
  const excerpt = text.slice(start, end);
  return {
    text: `${prefix}${excerpt}${end < text.length ? "…" : ""}`,
    ranges: ranges.flatMap((r) => {
      const from = Math.max(start, r.start);
      const to = Math.min(end, r.end);
      return to > from
        ? [{ start: from - start + prefix.length, end: to - start + prefix.length }]
        : [];
    }),
  };
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}
