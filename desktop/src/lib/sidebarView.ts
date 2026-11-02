import { useSyncExternalStore } from "react";

/**
 * 文件页侧栏当前显示哪一块：文件树 / 全工程搜索。
 *
 * 搜索原本是主导航里的独立页签，现在合并进文件页。入口有三个（侧栏标题栏的搜索
 * 按钮、Ctrl+K、按当前键位方案的全工程搜索键），它们都不在编辑器的上下游，
 * 状态只能放模块级仓库。不落 localStorage：搜索是临时视图，重启回到文件树。
 */
export type SidebarView = "files" | "search";

let view: SidebarView = "files";
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSidebarView(): SidebarView {
  return view;
}

export function setSidebarView(next: SidebarView): void {
  if (next === view) return;
  view = next;
  listeners.forEach((listener) => listener());
}

export function useSidebarView(): SidebarView {
  return useSyncExternalStore(subscribe, getSidebarView, getSidebarView);
}
