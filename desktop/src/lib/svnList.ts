import { isMarkable, keyOf, sortChanges, type ChangeItem, type ChangesView, type SortMode } from "./svn";
import { isSvnPicked } from "./svnDraft";

export type SvnFilter = "all" | "changed" | "untracked" | "conflict" | "unreviewed" | "reviewed" | "picked";
export const SVN_FILTERS: Record<SvnFilter, string> = { all: "全部", changed: "已改", untracked: "未纳管", conflict: "冲突", unreviewed: "未审", reviewed: "已审", picked: "已选" };
export function matchesSvnFilter(item: ChangeItem, filter: SvnFilter, reviewed: ReadonlySet<string>, picked: ReadonlySet<string>): boolean {
  switch (filter) {
    case "changed": return item.letter !== "?" && item.letter !== "C";
    case "untracked": return item.letter === "?";
    case "conflict": return item.letter === "C";
    case "unreviewed": return isMarkable(item) && !reviewed.has(keyOf(item.path));
    case "reviewed": return reviewed.has(keyOf(item.path));
    case "picked": return isSvnPicked(picked, item.path);
    default: return true;
  }
}
/**
 * 各筛选片上的数字，一趟算完。原来每个筛选各自 `filter` 一遍（7 遍），每次渲染都重算。
 * 口径与 `matchesSvnFilter` 逐一对应（有单测保证两边一致）。
 */
export function svnFilterCounts(items: readonly ChangeItem[], reviewed: ReadonlySet<string>, picked: ReadonlySet<string>): Record<SvnFilter, number> {
  const n: Record<SvnFilter, number> = { all: 0, changed: 0, untracked: 0, conflict: 0, unreviewed: 0, reviewed: 0, picked: 0 };
  for (const it of items) {
    n.all++;
    if (it.letter === "?") n.untracked++;
    else if (it.letter === "C") n.conflict++;
    else n.changed++;
    const done = reviewed.has(keyOf(it.path));
    if (done) n.reviewed++;
    else if (isMarkable(it)) n.unreviewed++;
    if (isSvnPicked(picked, it.path)) n.picked++;
  }
  return n;
}
export function svnVisibleGroups(view: ChangesView, filter: SvnFilter, search: string, sort: SortMode, showIgnored: boolean, reviewed: ReadonlySet<string>, picked: ReadonlySet<string>) {
  const q = search.trim().toLowerCase();
  return sortChanges(view.groups.map(g => ({ ...g, items: g.items.filter(it => (showIgnored || !it.ignored) && matchesSvnFilter(it, filter, reviewed, picked) && (!q || `${it.rel} ${it.module}`.toLowerCase().includes(q))) })).filter(g => g.items.length), sort);
}
/** 审查队列来自屏幕上的顺序；标记成功后仍以操作开始时的队列定位。 */
export function nextSvnUnreviewed(items: ChangeItem[], current: string | null, reviewed: ReadonlySet<string>, justMarked?: string): ChangeItem | null {
  const start = current ? items.findIndex(it => keyOf(it.path) === keyOf(current)) : -1;
  for (let n = 1; n <= items.length; n++) {
    const item = items[(start + n + items.length) % items.length];
    if (isMarkable(item) && !reviewed.has(keyOf(item.path)) && (!justMarked || keyOf(item.path) !== keyOf(justMarked))) return item;
  }
  return null;
}
