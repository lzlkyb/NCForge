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
import { getSession, subscribe as subscribeWorkspace } from "./workspaceSession";
import type { EditorGroupId } from "./editorGroups";

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


interface NavView {
  canBack: boolean;
  canForward: boolean;
  points: readonly NavPoint[];
  cursor: number;
}
const empty = () => ({ stack: [] as NavPoint[], cursor: -1, view: { canBack: false, canForward: false, points: [] as readonly NavPoint[], cursor: -1 } });
const histories = { left: empty(), right: empty() };
const history = () => histories[getSession().editorGroups?.focused ?? "left"];
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  const off = subscribeWorkspace(cb);
  return () => {
    listeners.delete(cb);
    off();
  };
};

const snapshot = (): NavView => history().view;

function recompute(): void {
  const h = history(), { stack, cursor } = h;
  if (h.view.points === stack && h.view.cursor === cursor) return;
  h.view = { canBack: cursor > 0, canForward: cursor >= 0 && cursor < stack.length - 1, points: stack, cursor };
  listeners.forEach((l) => l());
}

/**
 * 记一个跳跃点。
 *
 * - 与当前点**同文件同行**不记：连点两次同一条引用不该产生两个「上一处」；
 * - 记新点会砍掉游标之后的所有点（浏览器语义）：退两步再跳一下，前进那一支就作废了。
 */
export function pushNav(p: NavPoint): void {
  const h = history(), cur = h.stack[h.cursor];
  if (cur && cur.jdt === p.jdt && cur.path.toLowerCase() === p.path.toLowerCase() && cur.line === p.line) return;
  h.stack = [...h.stack.slice(0, h.cursor + 1), p].slice(-MAX);
  h.cursor = h.stack.length - 1;
  recompute();
}

/**
 * 一次待执行的历史跳转。
 *
 * 为什么是「先看后落」两步：打开目标文件可能失败（文件被删了、路径不在当前工程里），
 * 而以前是先把游标挪过去再打开。失败了游标已经走掉——用户想退回去的地方就这么没了，
 * 连点两次「后退」还会跳过一格。现在只有真打开了才 `navCommit`。
 */
export interface NavStep {
  /** 发生这次跳转的编辑器组：异步打开期间用户可能切组，落到别的组等于改错历史。 */
  group: EditorGroupId;
  index: number;
  point: NavPoint;
}

/** 看一眼后退 / 前进的目标，不动游标。 */
export function navLook(delta: -1 | 1): NavStep | null {
  return navLookAt(history().cursor + delta);
}

export function navLookAt(index: number): NavStep | null {
  const group = getSession().editorGroups?.focused ?? "left";
  const h = histories[group];
  if (!Number.isInteger(index) || index < 0 || index >= h.stack.length || index === h.cursor) return null;
  return { group, index, point: h.stack[index] };
}

/** 目标确实已经打开了，才把游标挪过去（保留它之后可前进的记录）。 */
export function navCommit(step: NavStep): void {
  const h = histories[step.group];
  if (!h || !h.stack[step.index] || h.cursor === step.index) return;
  h.cursor = step.index;
  recompute();
}

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
  histories.left = empty(); histories.right = empty(); listeners.forEach(l => l());
}

export function navSize(): number {
  return history().stack.length;
}

export function swapGroupNavigation(): void {
  const left = histories.left; histories.left = histories.right; histories.right = left;
  listeners.forEach(l => l());
}
export function mergeGroupNavigation(target: EditorGroupId, preferSource = false): void {
  const source = target === "left" ? "right" : "left";
  const active = histories[preferSource ? source : target], other = histories[preferSource ? target : source];
  const prefix = other.stack.slice(0, other.cursor + 1), all = [...prefix, ...active.stack], trim = Math.max(0, all.length - MAX);
  histories[target] = { ...empty(), stack: all.slice(trim), cursor: Math.max(-1, prefix.length + active.cursor - trim) };
  histories[source] = empty();
  const h = histories[target]; h.view = { canBack: h.cursor > 0, canForward: h.cursor >= 0 && h.cursor < h.stack.length - 1, points: h.stack, cursor: h.cursor };
  listeners.forEach(l => l());
}

export function useNav(): NavView {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
