import type { ReactNode } from "react";
import { matchRanges } from "../../lib/dbHistory";

/**
 * 把文本里命中关键词的部分包成 `<mark>`。
 *
 * 只在搜索时用：长 SQL 里到底匹配到哪一段，不给标记就要人自己一行行找。
 * 分段用 `matchRanges` 算好的区间，不重复跑正则（关键词里的 `(` `*` 会让正则出错）。
 */
export function Highlight({ text, query }: { text: string; query: string }) {
  const ranges = query.trim() ? matchRanges(text, query) : [];
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach((r, i) => {
    if (r.start > at) parts.push(text.slice(at, r.start));
    parts.push(<mark key={i}>{text.slice(r.start, r.end)}</mark>);
    at = r.end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
