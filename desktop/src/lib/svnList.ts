import { isMarkable, keyOf, sortChanges, type ChangeItem, type ChangesView, type SortMode } from "./svn";
import { isSvnPicked } from "./svnDraft";

export type SvnFilter = "all" | "changed" | "untracked" | "conflict" | "unreviewed" | "outdated" | "reviewed" | "picked";
export const SVN_FILTERS: Record<SvnFilter, string> = { all: "全部", changed: "已改", untracked: "未纳管", conflict: "冲突", unreviewed: "未审", outdated: "需重审", reviewed: "已审", picked: "已选" };
export function matchesSvnFilter(item: ChangeItem, filter: SvnFilter, reviewed: ReadonlySet<string>, picked: ReadonlySet<string>, outdated?: ReadonlySet<string>): boolean {
  switch (filter) {
    case "changed": return item.letter !== "?" && item.letter !== "C";
    case "untracked": return item.letter === "?";
    case "conflict": return item.letter === "C";
    case "unreviewed":
    case "outdated": {
      const key = keyOf(item.path);
      return isMarkable(item) && !reviewed.has(key) && Boolean(outdated?.has(key)) === (filter === "outdated");
    }
    case "reviewed": return reviewed.has(keyOf(item.path));
    case "picked": return isSvnPicked(picked, item.path);
    default: return true;
  }
}
/**
 * 各筛选片上的数字，一趟算完。原来每个筛选各自 `filter` 一遍（7 遍），每次渲染都重算。
 * 口径与 `matchesSvnFilter` 逐一对应（有单测保证两边一致）。
 */
export function svnFilterCounts(items: readonly ChangeItem[], reviewed: ReadonlySet<string>, picked: ReadonlySet<string>, outdated?: ReadonlySet<string>): Record<SvnFilter, number> {
  const n: Record<SvnFilter, number> = { all: 0, changed: 0, untracked: 0, conflict: 0, unreviewed: 0, outdated: 0, reviewed: 0, picked: 0 };
  for (const it of items) {
    n.all++;
    if (it.letter === "?") n.untracked++;
    else if (it.letter === "C") n.conflict++;
    else n.changed++;
    const done = reviewed.has(keyOf(it.path));
    if (done) n.reviewed++;
    else if (isMarkable(it)) n[outdated?.has(keyOf(it.path)) ? "outdated" : "unreviewed"]++;
    if (isSvnPicked(picked, it.path)) n.picked++;
  }
  return n;
}
export function svnVisibleGroups(view: ChangesView, filter: SvnFilter, search: string, sort: SortMode, showIgnored: boolean, reviewed: ReadonlySet<string>, picked: ReadonlySet<string>, outdated?: ReadonlySet<string>) {
  const q = search.trim().toLowerCase();
  return sortChanges(view.groups.map(g => ({ ...g, items: g.items.filter(it => (showIgnored || !it.ignored) && matchesSvnFilter(it, filter, reviewed, picked, outdated) && (!q || `${it.rel} ${it.module}`.toLowerCase().includes(q))) })).filter(g => g.items.length), sort);
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
/** shown / total / ignored 三个计数：与后端 `build_changes` 同一口径（shown = total − ignored）。 */
export function viewCounts(groups: readonly { items: readonly ChangeItem[] }[]) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const ignored = groups.reduce((n, g) => n + g.items.filter(it => it.ignored).length, 0);
  return { shown: total - ignored, total, ignored };
}
/**
 * 流式上屏：把一个模块扫到的条目并入当前视图。
 *
 * 同模块追加到已有组、新模块建组；计数重算。**同路径的条目后者替换前者**——
 * 根层 IMMEDIATES 与模块 INFINITY 都会报模块目录自身，增量刷新时缓存里还有同一
 * 路径的旧条目，不去重就会屏幕上出现两行同一个文件。替换而不是追加也保证了
 * 「增量刷新先种下缓存清单、脏模块的新条目再盖旧条目」这套玩法成立。
 *
 * **不排序**——扫描还没结束，排了下一批条目到来还是会变，纯浪费；最终结果到达时
 * 整份换成规范序（后端 build_changes 排好的）。
 */
export function mergeStreamedItems(view: ChangesView, items: readonly ChangeItem[]): ChangesView {
  const groups = view.groups.map(g => ({ ...g, items: [...g.items] }));
  for (const it of items) {
    let placed = false;
    for (const g of groups) {
      const at = g.items.findIndex(x => x.path === it.path);
      if (at >= 0) {
        g.items[at] = it;
        placed = true;
        break;
      }
    }
    if (placed) continue;
    const group = groups.find(g => g.module === it.module);
    if (group) group.items.push(it);
    else groups.push({ module: it.module, items: [it] });
  }
  return { groups, ...viewCounts(groups) };
}
