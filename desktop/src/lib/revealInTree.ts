// 「在文件树中显示」：把焦点移到文件页，并让树展开、滚动到指定文件。
//
// 走 window 事件而不是 prop 传递：发起方有三处（标签右键、命令面板、以后的搜索结果），
// 而文件树在 WorkbenchFrame 的独立子树里，props 一层层传会把中间组件全部污染。
// 事件名与 `ncforge-navigate` 保持同一套命名（见 App.tsx）。
export const REVEAL_IN_TREE_EVENT = "ncforge-reveal-in-tree";

/** jar 内的虚拟文件（`jdt://`）不在树里，直接忽略而不是弹一句"找不到"。 */
export function revealInTree(path: string | null): void {
  if (!path || path.startsWith("jdt://")) return;
  // 先切回文件页：树可能正被别的工具页挡着（服务/数据库）。
  // 切换是同步 setState，紧接着派发定位事件即可——树本身一直挂着，不需要等重挂载。
  window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
  window.dispatchEvent(new CustomEvent(REVEAL_IN_TREE_EVENT, { detail: path }));
}
