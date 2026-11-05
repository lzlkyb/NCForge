// 断点（文件 + 行）。
//
// 与书签同一套存法：localStorage、按工作区隔离。断点不像书签那样只是导航标记，
// 它要下发给调试适配器——但**存哪**仍属于「我这台机器上的调试位置」，不该写进
// AppConfig 被导入导出带到同事机器上（那边的行号与影子工程都对不上）。
//
// verified 不落盘：它是适配器对「这一行能不能停」的回答，每次附加都要重新问。
import { useLayoutEffect, useSyncExternalStore } from "react";
import type { BreakpointSpec } from "./debug";

/**
 * 一条断点。`enabled` / `condition` / `hitCondition` / `logMessage` 都可缺省：
 * 旧版本存下来的只有 path + line，读的时候按「启用、无条件」补齐。
 *
 * - `enabled = false`：留在清单里但不下发，gutter 画灰色空心点；
 * - `condition`：Java 布尔表达式，为假时不停；
 * - `hitCondition`：命中次数（支持 `5` / `>=5` / `%5`，由适配器解释）；
 * - `logMessage`：日志断点，命中时只输出消息、不停住（`{expr}` 由适配器插值）。
 */
export interface Breakpoint {
  path: string;
  line: number;
  enabled?: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** 条件类文本的长度上限：再长就不是人写的断点条件，而是把整段代码贴进来了。 */
const MAX_FIELD = 2000;

const keyOf = (root: string) => `ncforge-breakpoints:${root.toLowerCase()}`;

let currentRoot = "";
let items: Breakpoint[] = [];
const listeners = new Set<() => void>();

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** 同一文件同一行的键（面板、gutter、适配器回报共用一套口径）。 */
export const bpKey = (path: string, line: number) => `${norm(path)}#${line}`;

const cleanField = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().slice(0, MAX_FIELD);
  return text.length > 0 ? text : undefined;
};

/** 读盘数据 → 合法断点；非法条目丢弃，可选字段做白名单清洗。 */
function normalize(raw: unknown): Breakpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.path !== "string" || !b.path.trim()) return null;
  if (typeof b.line !== "number" || !Number.isInteger(b.line) || b.line < 1) return null;
  const item: Breakpoint = {
    path: b.path,
    line: b.line,
    enabled: b.enabled !== false,
  };
  const condition = cleanField(b.condition);
  const hitCondition = cleanField(b.hitCondition);
  const logMessage = cleanField(b.logMessage);
  if (condition) item.condition = condition;
  if (hitCondition) item.hitCondition = hitCondition;
  if (logMessage) item.logMessage = logMessage;
  return item;
}

export const isBreakpointEnabled = (b: Breakpoint): boolean => b.enabled !== false;

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
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    items = Array.isArray(parsed)
      ? parsed.map(normalize).filter((b): b is Breakpoint => b !== null)
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

/** 某个文件里的全部断点（升序，含禁用项——gutter 要能把禁用态画出来）。 */
export function breakpointItemsIn(path: string): Breakpoint[] {
  const k = norm(path);
  return items.filter((b) => norm(b.path) === k).sort((a, b) => a.line - b.line);
}

/** 某个文件里的启用断点行（升序）。 */
export function breakpointLinesIn(path: string): number[] {
  return breakpointItemsIn(path)
    .filter(isBreakpointEnabled)
    .map((b) => b.line);
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
  items = [...items, { path, line, enabled: true }];
  persist();
  emit();
  return "added";
}

/**
 * 改一条断点的启用状态或条件字段。`undefined` = 不改，空串 = 清掉该字段。
 * 返回是否真的找到并更新（找不到时调用方可提示「断点已被移除」）。
 */
export function updateBreakpointAt(
  path: string,
  line: number,
  patch: Partial<Pick<Breakpoint, "enabled" | "condition" | "hitCondition" | "logMessage">>,
): boolean {
  const k = bpKey(path, line);
  let found = false;
  items = items.map((b) => {
    if (bpKey(b.path, b.line) !== k) return b;
    found = true;
    const next: Breakpoint = { ...b };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    for (const field of ["condition", "hitCondition", "logMessage"] as const) {
      const raw = patch[field];
      if (raw === undefined) continue;
      const cleaned = cleanField(raw);
      if (cleaned) next[field] = cleaned;
      else delete next[field];
    }
    return next;
  });
  if (!found) return false;
  persist();
  emit();
  return true;
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
  /** 该文件要下发的启用断点（含条件字段）。整文件都禁用时为空数组。 */
  breakpoints: BreakpointSpec[];
}

/** 对应的下发签名：任一触发字段变化都要重发该文件。 */
export const breakpointGroupSig = (group: BreakpointGroup): string =>
  group.breakpoints
    .map((b) => `${b.line}\u0001${b.condition ?? ""}\u0001${b.hitCondition ?? ""}\u0001${b.logMessage ?? ""}`)
    .join("\u0002");

/**
 * 按文件分组（适配器一次收一个文件的断点集合；空集合 = 清空该文件）。
 *
 * 文件里全是被禁用的断点也会保留一个空组：那正是「把适配器上这批断点删掉」的信号。
 */
export function groupBreakpoints(list: Breakpoint[]): Map<string, BreakpointGroup> {
  const groups = new Map<string, BreakpointGroup>();
  for (const b of list) {
    const k = norm(b.path);
    const g = groups.get(k) ?? { path: b.path, breakpoints: [] };
    if (isBreakpointEnabled(b)) {
      const spec: BreakpointSpec = { line: b.line };
      if (b.condition) spec.condition = b.condition;
      if (b.hitCondition) spec.hitCondition = b.hitCondition;
      if (b.logMessage) spec.logMessage = b.logMessage;
      g.breakpoints.push(spec);
    }
    groups.set(k, g);
  }
  for (const g of groups.values()) g.breakpoints.sort((a, b) => a.line - b.line);
  return groups;
}
