// 书签（文件 + 行）。
//
// 存 localStorage 并按工作区隔离：书签是「我这台机器上的阅读位置」，跟着工程走，
// 不该写进 AppConfig（那会被配置导入导出带到同事机器上，指向不存在的行）。
//
// 与断点/问题的区别：它不参与任何构建或分析，纯标记；所以也没有后端参与。
import { useSyncExternalStore } from "react";

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

export function useBookmarks(root: string): Bookmark[] {
  loadBookmarks(root);
  return useSyncExternalStore(subscribe, getBookmarks, getBookmarks);
}

/** 这一行有没有书签（面板与状态栏用）。 */
export function bookmarkAt(path: string, line: number): Bookmark | undefined {
  return items.find((b) => same(b.path, path) && b.line === line);
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
