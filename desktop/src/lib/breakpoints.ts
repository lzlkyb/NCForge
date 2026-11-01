// 断点（文件 + 行）。
//
// 与书签同一套存法：localStorage、按工作区隔离。断点不像书签那样只是导航标记，
// 它要下发给调试适配器——但**存哪**仍属于「我这台机器上的调试位置」，不该写进
// AppConfig 被导入导出带到同事机器上（那边的行号与影子工程都对不上）。
//
// verified 不落盘：它是适配器对「这一行能不能停」的回答，每次附加都要重新问。
import { useLayoutEffect, useSyncExternalStore } from "react";

export interface Breakpoint {
  path: string;
  line: number;
}

const keyOf = (root: string) => `ncforge-breakpoints:${root.toLowerCase()}`;

let currentRoot = "";
let items: Breakpoint[] = [];
const listeners = new Set<() => void>();

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** 同一文件同一行的键（面板、gutter、适配器回报共用一套口径）。 */
export const bpKey = (path: string, line: number) => `${norm(path)}#${line}`;

/** 路径键；分组下发断点时用。 */
export const bpPathKey = norm;

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

/** 切工作区时调用（FilesTab 的接线 hook 负责）。 */
export function loadBreakpoints(root: string): void {
  if (root === currentRoot) return;
  currentRoot = root;
  try {
    const raw = localStorage.getItem(keyOf(root));
    const parsed = raw ? (JSON.parse(raw) as Breakpoint[]) : [];
    items = Array.isArray(parsed)
      ? parsed.filter(
          (b) =>
            b &&
            typeof b.path === "string" &&
            typeof b.line === "number" &&
            Number.isInteger(b.line) &&
            b.line > 0,
        )
      : [];
  } catch {
    items = [];
  }
  emit();
}

export function getBreakpoints(): Breakpoint[] {
  return items;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 非 React 订阅（gutter 与调试会话同步用）。 */
export const subscribeBreakpoints = subscribe;

export function useBreakpoints(root: string): Breakpoint[] {
  const list = useSyncExternalStore(subscribe, getBreakpoints, getBreakpoints);
  useLayoutEffect(() => {
    loadBreakpoints(root);
  }, [root]);
  return list;
}

export function hasBreakpointAt(path: string, line: number): boolean {
  const k = bpKey(path, line);
  return items.some((b) => bpKey(b.path, b.line) === k);
}

/** 某个文件里的全部断点行（升序）。 */
export function breakpointLinesIn(path: string): number[] {
  const k = norm(path);
  return items
    .filter((b) => norm(b.path) === k)
    .map((b) => b.line)
    .sort((a, b) => a - b);
}

/** 加/去断点，返回动作（给调用方弹提示）。 */
export function toggleBreakpointAt(path: string, line: number): "added" | "removed" {
  const k = bpKey(path, line);
  if (items.some((b) => bpKey(b.path, b.line) === k)) {
    items = items.filter((b) => bpKey(b.path, b.line) !== k);
    persist();
    emit();
    return "removed";
  }
  items = [...items, { path, line }];
  persist();
  emit();
  return "added";
}

export function removeBreakpointAt(path: string, line: number): void {
  const k = bpKey(path, line);
  if (!items.some((b) => bpKey(b.path, b.line) === k)) return;
  items = items.filter((b) => bpKey(b.path, b.line) !== k);
  persist();
  emit();
}

/** 清空某个文件的断点（文件被删除/移出工作区时用）。 */
export function clearFileBreakpoints(path: string): void {
  const k = norm(path);
  if (!items.some((b) => norm(b.path) === k)) return;
  items = items.filter((b) => norm(b.path) !== k);
  persist();
  emit();
}

/** 清空当前工作区的全部断点。 */
export function clearAllBreakpoints(): void {
  if (items.length === 0) return;
  items = [];
  persist();
  emit();
}

export interface BreakpointGroup {
  /** 原始路径（保留大小写与斜杠方向，下发给后端用）。 */
  path: string;
  lines: number[];
}

/** 按文件分组（适配器一次收一个文件的断点集合；空集合 = 清空该文件）。 */
export function groupBreakpoints(list: Breakpoint[]): Map<string, BreakpointGroup> {
  const groups = new Map<string, BreakpointGroup>();
  for (const b of list) {
    const k = norm(b.path);
    const g = groups.get(k) ?? { path: b.path, lines: [] };
    g.lines.push(b.line);
    groups.set(k, g);
  }
  for (const g of groups.values()) g.lines.sort((a, b) => a - b);
  return groups;
}
