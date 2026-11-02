/**
 * 已关闭标签的栈（Ctrl+Shift+T 重新打开）。
 *
 * 只记路径：重开时按磁盘内容重建 model，关闭时没保存的改动本来就已征得用户同意丢弃。
 * jar 内的 `jdt://` 类不记——它没有「重新读一遍」的路径，重开会直接报错。
 */
const MAX = 20;
const stack: string[] = [];

export function rememberClosed(path: string): void {
  if (path.startsWith("jdt://")) return;
  const i = stack.indexOf(path);
  if (i >= 0) stack.splice(i, 1);
  stack.push(path);
  if (stack.length > MAX) stack.shift();
}

/** 取出最近关闭的一个；没有返回 null。 */
export function popClosed(): string | null {
  return stack.pop() ?? null;
}

export function closedCount(): number {
  return stack.length;
}

/** 换工作区时清空：旧工程的路径重开只会报错。 */
export function clearClosed(): void {
  stack.length = 0;
}
