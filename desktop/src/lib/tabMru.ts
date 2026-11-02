/**
 * 标签的最近使用顺序（Ctrl+Tab）。
 *
 * 顺序只记在内存里：它是「这次运行中先看了哪个」的临时事实，重启后没有意义。
 * 打开/关闭标签时由文件页把顺序裁剪到现存标签，避免把已关的路径当成目标。
 */
const order: string[] = [];
const MAX = 50;

/** 记一次激活：放到最前。 */
export function touchMru(path: string | null | undefined): void {
  if (!path) return;
  const i = order.indexOf(path);
  if (i >= 0) order.splice(i, 1);
  order.unshift(path);
  if (order.length > MAX) order.length = MAX;
}

/** 把已关闭的标签从顺序里剔掉。 */
export function pruneMru(openPaths: string[]): void {
  const open = new Set(openPaths);
  for (let i = order.length - 1; i >= 0; i--) {
    if (!open.has(order[i])) order.splice(i, 1);
  }
}

/**
 * 从当前标签按 MRU 找下一个。
 *
 * `dir = 1` 是上一个用过的（Ctrl+Tab 的直觉：回到刚离开的那个），
 * `dir = -1` 是最久没用的（Ctrl+Shift+Tab）。
 */
export function mruNeighbor(current: string | null, openPaths: string[], dir: 1 | -1): string | null {
  if (openPaths.length < 2) return null;
  const open = new Set(openPaths);
  const list = order.filter((p) => open.has(p));
  // 顺序表可能还没收到当前标签（比如刚恢复会话）：把它补到最前，不能让它参与「上一个」
  if (current && !list.includes(current)) list.unshift(current);
  if (list.length < 2) {
    // 顺序表里只有一个（或为空）：退回标签栏顺序，至少 Ctrl+Tab 不是死键
    const i = current ? openPaths.indexOf(current) : -1;
    return i >= 0 ? openPaths[(i + (dir === 1 ? 1 : openPaths.length - 1)) % openPaths.length] : openPaths[0];
  }
  return dir === 1 ? list[1] : list[list.length - 1];
}

/** 换工作区时清空（旧工程路径没有意义）。 */
export function resetMru(): void {
  order.length = 0;
}
