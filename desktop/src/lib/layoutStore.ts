import { useSyncExternalStore } from "react";

/**
 * 工作台外壳的开合状态（侧栏）。
 *
 * 放模块级仓库而不是组件 state：开合来自三个互不相干的入口——侧栏竖栏重复点击、
 * Ctrl+B、命令面板——它们不在同一棵组件树的上下游。记住上次的开合，重启后保持。
 */
const KEY = "ncforge-side-open";
/** 主导航栏展开态：默认收起（图标栏），展开后显示中文页名。 */
const RAIL_KEY = "ncforge-rail-expanded";

function load(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

function loadRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

let sideOpen = load();
let railExpanded = loadRail();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setSideOpen(open: boolean): void {
  if (open === sideOpen) return;
  sideOpen = open;
  try {
    localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    /* 隐私模式 / 配额：只是不记住 */
  }
  listeners.forEach((l) => l());
}

export function toggleSide(): void {
  setSideOpen(!sideOpen);
}

export function getSideOpen(): boolean {
  return sideOpen;
}

export function useSideOpen(): boolean {
  return useSyncExternalStore(subscribe, getSideOpen, getSideOpen);
}

export function setRailExpanded(open: boolean): void {
  if (open === railExpanded) return;
  railExpanded = open;
  try {
    localStorage.setItem(RAIL_KEY, open ? "1" : "0");
  } catch {
    /* 隐私模式 / 配额：只是不记住 */
  }
  listeners.forEach((l) => l());
}

export function toggleRail(): void {
  setRailExpanded(!railExpanded);
}

export function getRailExpanded(): boolean {
  return railExpanded;
}

export function useRailExpanded(): boolean {
  return useSyncExternalStore(subscribe, getRailExpanded, getRailExpanded);
}
