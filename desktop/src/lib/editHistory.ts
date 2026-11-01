// 「上一次编辑位置」（IDEA 的 Ctrl+Shift+Backspace）。
//
// 与「后退」的区别：`navHistory` 记的是**跳转**（点搜索结果、F3、点问题），
// 这里记的是**打字**。改完一处去别处改，想回到刚才打字的地方时，后退帮不上忙。
//
// 只存路径 + 行，不存列：列在代码改动后很容易失效，行也有同样问题，但行的偏差
// 靠编辑器定位夹取就能兜住，列会指到句子中间。
export interface EditSpot {
  path: string;
  line: number;
  at: number;
}

const MAX = 50;
let stack: EditSpot[] = [];

const same = (a: string, b: string) =>
  a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/**
 * 记一次编辑。同一个位置连续输入只记一条（否则打一百个字就有一百个"上一步"）。
 */
export function noteEdit(path: string, line: number): void {
  const top = stack[stack.length - 1];
  if (top && same(top.path, path) && top.line === line) return;
  stack.push({ path, line, at: Date.now() });
  if (stack.length > MAX) stack = stack.slice(-MAX);
}

/**
 * 取上一个编辑位置并出栈。
 *
 * `current` 是当前所在位置：连点两次不该原地打转（第一次的"上一步"可能还是自己）。
 * 返回后调用方负责跳转。
 */
export function previousEditSpot(current: { path: string; line: number } | null): EditSpot | null {
  while (stack.length > 0) {
    const spot = stack.pop()!;
    if (current && same(spot.path, current.path) && spot.line === current.line) continue;
    // 与当前位置同一行的相邻位置也别跳了：视觉上「没动」
    if (current && same(spot.path, current.path) && Math.abs(spot.line - current.line) <= 1) continue;
    return spot;
  }
  return null;
}

/** 清空（换工作区时）。 */
export function resetEditSpots(): void {
  stack = [];
}

/** 只读快照（测试与状态栏用）。 */
export function editSpots(): readonly EditSpot[] {
  return stack;
}
