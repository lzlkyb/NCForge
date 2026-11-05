// 导航历史：跳跃点的前进 / 后退。
//
// 为什么必须做：有了「找引用」「跳实现」「跳到下一个类」之后，一次排查会在十几个文件之间
// 来回跳；没有后退栈的编辑器，人只能靠标签页记得「我刚才从哪儿来」，而标签页只记得文件、
// 不记得行。
//
// 形状上就是一个数组 + 游标，纯逻辑，能单测。放在模块级单例里而不是组件 state：
// 文件页切走再回来，历史不该清空（与 workspaceSession 同一个理由）。
import { useSyncExternalStore } from "react";
import { getCursor } from "./cursorStore";
import { getSession } from "./workspaceSession";

export interface NavPoint {
  /** 文件路径（`jdt://` 开头的表示 jar 里的类）。 */
  path: string;
  line: number;
  column?: number;
  symbol?: string;
  /** jdt 目标要走「打开 jar 内类」那条路，不能当磁盘文件读。 */
  jdt?: boolean;
}

/**
 * 栈深上限。
 *
 * 只留最近 60 个点：一次排查的跳跃很少超过它，而无限增长会让「后退」在按了很多次之后
 * 退到一个上午以前的文件，反而更难回到刚才那步。
 */
const MAX = 60;

let stack: NavPoint[] = [];
/** 当前所在的点。栈为空时是 -1。 */
let cursor = -1;

interface NavView {
  canBack: boolean;
  canForward: boolean;
  points: readonly NavPoint[];
  cursor: number;
}
let view: NavView = { canBack: false, canForward: false, points: stack, cursor };
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const snapshot = (): NavView => view;

function recompute(): void {
  if (view.points === stack && view.cursor === cursor) return;
  view = { canBack: cursor > 0, canForward: cursor >= 0 && cursor < stack.length - 1, points: stack, cursor };
  listeners.forEach((l) => l());
}

/**
 * 记一个跳跃点。
 *
 * - 与当前点**同文件同行**不记：连点两次同一条引用不该产生两个「上一处」；
 * - 记新点会砍掉游标之后的所有点（浏览器语义）：退两步再跳一下，前进那一支就作废了。
 */
export function pushNav(p: NavPoint): void {
  const cur = stack[cursor];
  if (cur && cur.jdt === p.jdt && cur.path.toLowerCase() === p.path.toLowerCase() && cur.line === p.line) return;
  stack = [...stack.slice(0, cursor + 1), p].slice(-MAX);
  cursor = stack.length - 1;
  recompute();
}

/** 回到栈内某个位置，保留它之后可前进的记录。 */
export function navAt(index: number): NavPoint | null {
  if (!Number.isInteger(index) || index < 0 || index >= stack.length || index === cursor) return null;
  cursor = index;
  recompute();
  return stack[cursor];
}

export function navBack(): NavPoint | null { return navAt(cursor - 1); }
export function navForward(): NavPoint | null { return navAt(cursor + 1); }

export function captureNavOrigin(): NavPoint | null {
  const path = getSession().activePath;
  return path ? { path, ...getCursor(), jdt: path.startsWith("jdt://") || undefined } : null;
}

export function recordNavJump(origin: NavPoint | null, target: NavPoint): void {
  if (origin) pushNav(origin);
  pushNav(target);
}

/** 清空（换工作区时）。旧工作区的路径在新区里点开只会被守卫挡住。 */
export function resetNav(): void {
  stack = [];
  cursor = -1;
  recompute();
}

export function navSize(): number {
  return stack.length;
}

export function useNav(): NavView {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
