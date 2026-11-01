// 书签（文件 + 行）。
//
// 存 localStorage 并按工作区隔离：书签是「我这台机器上的阅读位置」，跟着工程走，
// 不该写进 AppConfig（那会被配置导入导出带到同事机器上，指向不存在的行）。
//
// 与断点/问题的区别：它不参与任何构建或分析，纯标记；所以也没有后端参与。
import { useLayoutEffect, useSyncExternalStore } from "react";

export interface Bookmark {
  path: string;
  line: number;
  /** 加书签时那行的内容摘要（只有面板里显示，用于在代码改动后仍能认出它）。 */
  note: string;
  at: number;
}

const keyOf = (root: string) => `ncforge-bookmarks:${root.toLowerCase()}`;

let currentRoot = "";
let items: Bookmark[] = [];
const listeners = new Set<() => void>();

const same = (a: string, b: string) =>
  a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/** 归一后的路径键：文件树、书签面板用同一套键比对（斜杠方向、大小写、末尾斜杠都不影响）。 */
export const bookmarkPathKey = (path: string) =>
  path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function emit(): void {
  listeners.forEach((l) => l());
}

function persist(): void {
  try {
    localStorage.setItem(keyOf(currentRoot), JSON.stringify(items));
  } catch {
    // 配额满 / 隐私模式：本次会话内仍可用
  }
}

/** 切工作区时调用（也由 `useBookmarks` 自动做）。 */
export function loadBookmarks(root: string): void {
  if (root === currentRoot) return;
  currentRoot = root;
  try {
    const raw = localStorage.getItem(keyOf(root));
    const parsed = raw ? (JSON.parse(raw) as Bookmark[]) : [];
    items = Array.isArray(parsed) ? parsed.filter((b) => b && typeof b.path === "string") : [];
  } catch {
    items = [];
  }
  emit();
}

export function getBookmarks(): Bookmark[] {
  return items;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 非 React 订阅（Monaco 的行号槽不在 React 树里）。 */
export const subscribeBookmarks = subscribe;

export function useBookmarks(root: string): Bookmark[] {
  const items = useSyncExternalStore(subscribe, getBookmarks, getBookmarks);
  // 换工作区在 effect 里加载：多个组件同时挂着这个 hook 时，在渲染期间 emit
  // 会去更新别的组件（React 会报「渲染中更新另一个组件」）。layout effect
  // 赶在绘制前拿到新工作区的清单，看不到旧工程的标记闪一帧。
  useLayoutEffect(() => {
    loadBookmarks(root);
  }, [root]);
  return items;
}

/** 这一行有没有书签（面板与状态栏用）。 */
export function bookmarkAt(path: string, line: number): Bookmark | undefined {
  return items.find((b) => same(b.path, path) && b.line === line);
}

/** 某个文件里的全部书签（编辑器行号槽用）；按行号升序，便于稳定地铺装饰。 */
export function bookmarkLinesIn(path: string): { line: number; note: string }[] {
  return items
    .filter((b) => same(b.path, path))
    .sort((a, b) => a.line - b.line)
    .map((b) => ({ line: b.line, note: b.note }));
}

/** 文件 → 书签条数（文件树打点用）。键与树上的 `pathKey` 同口径。 */
export function countBookmarks(list: Bookmark[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of list) {
    const k = bookmarkPathKey(b.path);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** 加/去书签。返回加完之后的动作（给调用方弹提示）。 */
export function toggleBookmark(path: string, line: number, note: string): "added" | "removed" {
  const at = bookmarkAt(path, line);
  if (at) {
    items = items.filter((b) => b !== at);
    persist();
    emit();
    return "removed";
  }
  items = [...items, { path, line, note: note.trim().slice(0, 120), at: Date.now() }];
  persist();
  emit();
  return "added";
}

export function removeBookmark(path: string, line: number): void {
  const at = bookmarkAt(path, line);
  if (!at) return;
  items = items.filter((b) => b !== at);
  persist();
  emit();
}

/** 清空当前工作区的全部书签（面板上的「全部清除」）。 */
export function clearBookmarks(): void {
  items = [];
  persist();
  emit();
}
