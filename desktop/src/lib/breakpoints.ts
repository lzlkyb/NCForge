// 断点（文件 + 行）。
//
// 与书签同一套存法：localStorage、按工作区隔离。断点不像书签那样只是导航标记，
// 它要下发给调试适配器——但**存哪**仍属于「我这台机器上的调试位置」，不该写进
// AppConfig 被导入导出带到同事机器上（那边的行号与影子工程都对不上）。
//
// verified 不落盘：它是适配器对「这一行能不能停」的回答，每次附加都要重新问。
//
// 分组与静音（Mute）也在这里：组名挂在每条断点的 `group` 字段上，「组被禁用」
// 与「全局静音」是会话级偏好，与清单同键存盘（v2 形状，v1 裸数组兼容）。
// 纯函数（清洗 / 判定 / 清单变换）在 `breakpointGroups.ts`，配单测。
import { useLayoutEffect, useSyncExternalStore } from "react";
import type { BreakpointSpec } from "./debug";
import {
  cleanGroupName,
  groupInfos,
  isGroupEnabled,
  normalizeStored,
  pruneDisabledGroups,
  renameGroupInList,
  clearGroupInList,
  type BreakpointGroupInfo,
} from "./breakpointGroups";

/**
 * 一条断点。`enabled` / `condition` / `hitCondition` / `logMessage` / `group`
 * 都可缺省：旧版本存下来的只有 path + line，读的时候按「启用、无条件、默认组」补齐。
 *
 * - `enabled = false`：留在清单里但不下发，gutter 画灰色空心点；
 * - `condition`：Java 布尔表达式，为假时不停。适配器（java-debug 0.32.0）在
 *   「命中时」才交给 JDT 编译，语法错误没有保存期反馈——保存前由
 *   `breakpointCondition.ts` 做静态校验；
 * - `hitCondition`：命中次数。适配器只 Integer.parseInt 后设 countFilter，
 *   **仅支持正整数 N（第 N 次命中才停）**；`>=5` / `%5` 会被静默忽略（0.32.0
 *   实测），编辑表单按 `validateHitCondition` 挡掉；
 * - `logMessage`：日志断点，命中时只输出消息、不停住（`{expr}` 由适配器插值）。
 *   注意：附加（attach）模式下输出进的是被调试 JVM 自己的 stdout，适配器
 *   不转发，工作台里看不到；求值失败的诊断走 usernotification 事件落到控制台；
 * - `group`：所属组名（缺省 = 默认组，永远启用）；组被禁用时组内全部不下发。
 */
export interface Breakpoint {
  path: string;
  line: number;
  enabled?: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  group?: string;
}

/** 条件类文本的长度上限：再长就不是人写的断点条件，而是把整段代码贴进来了。 */
const MAX_FIELD = 2000;

const keyOf = (root: string) => `ncforge-breakpoints:${root.toLowerCase()}`;

let currentRoot = "";
let items: Breakpoint[] = [];
/** 全局静音：清单原样保留、gutter 照画，但一个都不下发（取消即整批恢复）。 */
let muted = false;
/** 被禁用的组名（成员断点仍在清单里，只是不下发）。 */
let disabledGroups: string[] = [];
const listeners = new Set<() => void>();

/**
 * 给 React 的统一快照：清单 / 静音 / 组偏好任一变化都换引用。
 *
 * 🔴 为什么需要它（2026-11-18 踩过）：`useSyncExternalStore` 靠**快照引用变化**
 * 决定要不要重渲染。静音与组禁用不动 `items` 数组，早期版本里这两个操作改完
 * 状态、面板却毫无反应——localStorage 落了、UI 没刷新。emit 时统一重建 view，
 * 订阅方（面板）拿到的就是「变了」的信号。
 */
export interface BreakpointsView {
  items: Breakpoint[];
  muted: boolean;
  disabledGroups: string[];
}

let view: BreakpointsView = { items, muted, disabledGroups };

function rebuildView(): void {
  view = { items, muted, disabledGroups };
}

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
  const group = cleanGroupName(b.group);
  if (condition) item.condition = condition;
  if (hitCondition) item.hitCondition = hitCondition;
  if (logMessage) item.logMessage = logMessage;
  if (group) item.group = group;
  return item;
}

export const isBreakpointEnabled = (b: Breakpoint): boolean => b.enabled !== false;

/** 这条断点此刻是否生效（启用 + 组启用）。全局静音不在这里判：它要让
 *  「运行到光标处」的临时断点也能绕过去（debugSync.groupsForTarget）。 */
export const isBreakpointActive = (b: Breakpoint): boolean =>
  isBreakpointEnabled(b) && isGroupEnabled(disabledGroups, b.group);

/** 一条断点「为什么没生效」：null = 生效中。gutter 悬停与面板置灰都靠它写说明。 */
export function breakpointInactiveReason(b: Breakpoint): "muted" | "group" | "off" | null {
  if (muted) return "muted";
  if (!isGroupEnabled(disabledGroups, b.group)) return "group";
  if (!isBreakpointEnabled(b)) return "off";
  return null;
}

function emit(): void {
  // 快照引用必须换：useSyncExternalStore 认不出「只改了静音」
  rebuildView();
  listeners.forEach((l) => l());
}

function persist(): void {
  try {
    const stored = {
      items,
      muted,
      // 清空断点后禁用清单不该留幽灵组名：重组同名时会莫名被禁用
      disabledGroups: pruneDisabledGroups(disabledGroups, items),
    };
    disabledGroups = stored.disabledGroups;
    localStorage.setItem(keyOf(currentRoot), JSON.stringify(stored));
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
    const stored = normalizeStored(raw ? (JSON.parse(raw) as unknown) : []);
    items = stored.items
      .map(normalize)
      .filter((b): b is Breakpoint => b !== null);
    muted = stored.muted;
    disabledGroups = pruneDisabledGroups(stored.disabledGroups, items);
  } catch {
    items = [];
    muted = false;
    disabledGroups = [];
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

/** React 用的统一快照（清单 + 静音 + 组偏好）。任一变化都换引用。 */
export const getBreakpointsView = (): BreakpointsView => view;

export function useBreakpoints(root: string): BreakpointsView {
  const v = useSyncExternalStore(subscribe, getBreakpointsView, getBreakpointsView);
  useLayoutEffect(() => {
    loadBreakpoints(root);
  }, [root]);
  return v;
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
 * `group` 传空串/null = 回到默认组。返回是否真的找到并更新（找不到时调用方可提示「断点已被移除」）。
 */
export function updateBreakpointAt(
  path: string,
  line: number,
  patch: Partial<Pick<Breakpoint, "enabled" | "condition" | "hitCondition" | "logMessage" | "group">>,
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
    if (patch.group !== undefined) {
      const group = cleanGroupName(patch.group);
      if (group) next.group = group;
      else delete next.group;
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

// ── 静音（Mute）与分组 ─────────────────────────────────────────────────────
// 静音 = IDEA 的 Mute Breakpoints：断点清单与 gutter 原样保留，但一个都不下发；
// 取消即整批恢复（debugSync 靠签名差异重发，不需要额外记「发过什么」）。
export const isMuted = (): boolean => muted;

export function setMuted(on: boolean): void {
  if (muted === on) return;
  muted = on;
  persist();
  emit();
}

/** 全部组（按名字排序）。count 含组内禁用项——那才是「这个组有多大」。 */
export function breakpointGroups(): BreakpointGroupInfo[] {
  return groupInfos(items, disabledGroups);
}

/** 启用/禁用整组（立即影响下发：debugSync 订阅清单变化，这里也要 emit）。 */
export function setBreakpointGroupEnabled(group: string, on: boolean): void {
  const has = disabledGroups.includes(group);
  if (has === !on) return;
  disabledGroups = on ? disabledGroups.filter((g) => g !== group) : [...disabledGroups, group];
  persist();
  emit();
}

/** 把一条断点放进某个组 / 挪回默认组（group 为空）。返回是否找到断点。 */
export function setBreakpointGroup(path: string, line: number, group: string | null): boolean {
  return updateBreakpointAt(path, line, { group: group ?? "" });
}

/** 重命名组：返回迁移的断点数。目标名已被别的组占用时拒绝（返回 -1）。 */
export function renameBreakpointGroup(from: string, to: string): number {
  const next = cleanGroupName(to);
  if (!next || from === next) return 0;
  if (items.some((b) => b.group === next)) return -1;
  const moved = items.filter((b) => b.group === from).length;
  if (moved === 0) return 0;
  items = renameGroupInList(items, from, next);
  disabledGroups = disabledGroups.map((g) => (g === from ? next : g));
  persist();
  emit();
  return moved;
}

/** 解散组：断点全部回到默认组（不断点本身）。返回解散的断点数。 */
export function clearBreakpointGroup(name: string): number {
  const moved = items.filter((b) => b.group === name).length;
  if (moved === 0) return 0;
  items = clearGroupInList(items, name);
  persist();
  emit();
  return moved;
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
 * 文件里全是不生效的断点（禁用 / 组禁用）也会保留一个空组：那正是「把适配器上
 * 这批断点删掉」的信号。全局静音不在这里判——debugSync 的 groupsForTarget 直接
 * 返回空 map，让「运行到光标处」的临时断点还能绕过去。
 */
export function groupBreakpoints(list: Breakpoint[]): Map<string, BreakpointGroup> {
  const groups = new Map<string, BreakpointGroup>();
  for (const b of list) {
    const k = norm(b.path);
    const g = groups.get(k) ?? { path: b.path, breakpoints: [] };
    if (isBreakpointActive(b)) {
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

/* 响应式布局断点已迁到 `lib/layoutBreakpoints.ts`：本文件是「Java 调试断点
   （文件 + 行）」，两者同名会让 import 时反复看错模块。 */
