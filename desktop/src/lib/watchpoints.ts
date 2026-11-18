// 字段观察点（watchpoint）：观察某个对象字段的读 / 写 / 读写。
//
// 与断点同一套存法：localStorage、按工作区隔离。观察点挂在「类#字段」上，
// 与具体栈帧无关——暂停时从变量树点「眼睛」加入，恢复后继续有效。
//
// dataId 只来自适配器 `dataBreakpointInfo` 的回报（形状「类名#字段名」，
// java-debug 0.32.0 用 `#` 分隔、两段必须非空）；本地不拼 dataId——子类实例
// 的字段可能声明在父类，运行时类型名未必是声明类，适配器才是真相。
//
// verified 不落盘：它是适配器对「这个字段装上了观察点吗」的回答，
// 每次附加重新问（回映射见 `watchpointSync.ts`：响应与请求逐项同序）。
import { useLayoutEffect, useSyncExternalStore } from "react";
import type { DataBreakpointAccessType } from "./debug";

/**
 * 一个字段观察点。
 *
 * - `accessType`：read = 只观察读取；write = 只观察改写；readWrite = 两者都观察
 *   （适配器按此分派 JDI AccessWatchpoint / ModificationWatchpoint 请求）；
 * - `condition` / `hitCondition`：与行断点同一套触发语义——条件命中时才编译，
 *   hitCondition 只认正整数（`>=5` / `%5` 会被静默按 0），保存前的静态校验
 *   复用 `breakpointCondition.ts`；
 * - `enabled = false`：留在清单里但不下发。
 */
export interface Watchpoint {
  dataId: string;
  accessType: DataBreakpointAccessType;
  condition?: string;
  hitCondition?: string;
  enabled?: boolean;
}

/** 条件类文本的长度上限（与断点同一口径）。 */
const MAX_FIELD = 2000;

const keyOf = (root: string) => `ncforge-watchpoints:${root.toLowerCase()}`;

/** accessType 循环顺序：读 → 写 → 读写 → 读。 */
const ACCESS_CYCLE: DataBreakpointAccessType[] = ["read", "write", "readWrite"];

export const nextAccessType = (a: DataBreakpointAccessType): DataBreakpointAccessType =>
  ACCESS_CYCLE[(ACCESS_CYCLE.indexOf(a) + 1) % ACCESS_CYCLE.length];

export const accessTypeLabel = (a: DataBreakpointAccessType): string =>
  a === "read" ? "读" : a === "write" ? "写" : "读写";

let currentRoot = "";
let items: Watchpoint[] = [];
const listeners = new Set<() => void>();

/**
 * 给 React 的统一快照（🔴 2026-11-18 踩坑同款）：`useSyncExternalStore` 靠
 * **快照引用变化**决定重渲染，任何改动都必须换引用，不能就地改数组。
 */
let view: Watchpoint[] = items;

function rebuildView(): void {
  view = items;
}

function emit(): void {
  rebuildView();
  listeners.forEach((l) => l());
}

function persist(): void {
  try {
    localStorage.setItem(keyOf(currentRoot), JSON.stringify(items));
  } catch {
    // 配额满 / 隐私模式：本次会话内仍可用
  }
}

const cleanField = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().slice(0, MAX_FIELD);
  return text.length > 0 ? text : undefined;
};

const isAccessType = (v: unknown): v is DataBreakpointAccessType =>
  v === "read" || v === "write" || v === "readWrite";

/** 读盘数据 → 合法观察点；非法条目丢弃（dataId 必须是「两段非空」的 `类#字段`）。 */
function normalize(raw: unknown): Watchpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.dataId !== "string") return null;
  const parts = w.dataId.split("#");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return null;
  const item: Watchpoint = {
    dataId: w.dataId,
    accessType: isAccessType(w.accessType) ? w.accessType : "readWrite",
    enabled: w.enabled !== false,
  };
  const condition = cleanField(w.condition);
  const hitCondition = cleanField(w.hitCondition);
  if (condition) item.condition = condition;
  if (hitCondition) item.hitCondition = hitCondition;
  return item;
}

/** 切工作区时调用（接线与断点 store 同一处）。 */
export function loadWatchpoints(root: string): void {
  if (root === currentRoot) return;
  currentRoot = root;
  try {
    const raw = localStorage.getItem(keyOf(root));
    items = raw ? (JSON.parse(raw) as unknown[]).map(normalize).filter((w): w is Watchpoint => w !== null) : [];
  } catch {
    items = [];
  }
  emit();
}

export function getWatchpoints(): Watchpoint[] {
  return items;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const subscribeWatchpoints = subscribe;

/** React 用的统一快照。 */
export const getWatchpointsView = (): Watchpoint[] => view;

export function useWatchpoints(root: string): Watchpoint[] {
  const v = useSyncExternalStore(subscribe, getWatchpointsView, getWatchpointsView);
  useLayoutEffect(() => {
    loadWatchpoints(root);
  }, [root]);
  return v;
}

export const isWatchpointEnabled = (w: Watchpoint): boolean => w.enabled !== false;

/** 加一个观察点。同一 dataId 已存在时视为「已观察」（返回 false，不重复）。 */
export function addWatchpoint(w: Watchpoint): boolean {
  if (items.some((x) => x.dataId === w.dataId)) return false;
  items = [...items, normalize(w) ?? w];
  persist();
  emit();
  return true;
}

export function removeWatchpoint(dataId: string): void {
  if (!items.some((w) => w.dataId === dataId)) return;
  items = items.filter((w) => w.dataId !== dataId);
  persist();
  emit();
}

/** 循环访问类型 read → write → readWrite。返回新值（调用方做提示）。 */
export function cycleWatchpointAccess(dataId: string): DataBreakpointAccessType | null {
  const found = items.find((w) => w.dataId === dataId);
  if (!found) return null;
  const next = nextAccessType(found.accessType);
  items = items.map((w) => (w.dataId === dataId ? { ...w, accessType: next } : w));
  persist();
  emit();
  return next;
}

export function setWatchpointEnabled(dataId: string, on: boolean): void {
  items = items.map((w) => (w.dataId === dataId ? { ...w, enabled: on } : w));
  persist();
  emit();
}

/** 改条件 / 命中次数。`undefined` = 不改，空串 = 清掉该字段。 */
export function updateWatchpoint(
  dataId: string,
  patch: Partial<Pick<Watchpoint, "condition" | "hitCondition">>,
): boolean {
  let found = false;
  items = items.map((w) => {
    if (w.dataId !== dataId) return w;
    found = true;
    const next: Watchpoint = { ...w };
    for (const field of ["condition", "hitCondition"] as const) {
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

/** 清空当前工作区的全部观察点。 */
export function clearAllWatchpoints(): void {
  if (items.length === 0) return;
  items = [];
  persist();
  emit();
}

/** 「nc.ui.pubapp.Caps#total」→「Caps.total」（面板展示用短名）。 */
export function watchpointDisplay(dataId: string): string {
  const [cls, field] = dataId.split("#");
  const simple = cls.split(".").pop() ?? cls;
  return `${simple}.${field}`;
}
