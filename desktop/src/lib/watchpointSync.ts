// 字段观察点 ←→ 调试适配器的同步。
//
// 与 `debugSync.ts`（行断点）平行的第二套同步：那边按文件分组、这边整目标一批
// （`setDataBreakpoints` 一次收全清单）。verified 的回映射方式不同——
// 🔴 响应 `breakpoints` 数组与请求**逐项同序**：java-debug 0.32.0 的
// `Types$Breakpoint` 上没有 dataId 字段（字节码确认 convertDebuggerWatchpointToClient
// 只写 id+verified），只能按位置对。所以 Rust 侧不过滤、不重排，前端也不重排。
//
// 观察点挂在「类#字段」上，与栈帧无关：暂停时加入、恢复后继续有效，
// 不需要在每次 stopped 时重发；只有清单变化 / 附加 / 断开才动适配器。
import type { DebugTarget, DataBreakpointSpec, DapBreakpoint } from "./debug";
import { DEBUG_TARGETS, debugSetDataBreakpoints } from "./debug";
import { getWatchpoints, isWatchpointEnabled, subscribeWatchpoints } from "./watchpoints";

const emptyVerified = (): Record<DebugTarget, Record<string, boolean>> => ({
  server: {},
  client: {},
  remote: {},
});

let verified = emptyVerified();
let verifiedVersion = 0;
const verifiedListeners = new Set<() => void>();

export function subscribeWatchpointVerified(cb: () => void): () => void {
  verifiedListeners.add(cb);
  return () => {
    verifiedListeners.delete(cb);
  };
}

/** verified 变化版本号：面板用 useSyncExternalStore 订阅它触发重渲染。 */
export const getWatchpointVerifiedVersion = (): number => verifiedVersion;

/** 这个字段在任一已附加目标上装上了观察点（面板画实心眼睛用）。 */
export function isWatchpointVerified(dataId: string): boolean {
  return DEBUG_TARGETS.some((t) => verified[t][dataId] === true);
}

/**
 * 把 `setDataBreakpoints` 的回报按位置映射回条目。
 *
 * `dataIds` 必须与请求里的 breakpoints 逐项同序；回报缺数组时全记 false
 * （不能让上一轮的 true 留下——清单刚变过，旧状态不适用于新清单）。
 */
export function applyWatchpointVerified(
  target: DebugTarget,
  dataIds: string[],
  list: DapBreakpoint[] | undefined,
): void {
  const next: Record<string, boolean> = {};
  for (let i = 0; i < dataIds.length; i++) next[dataIds[i]] = !!list?.[i]?.verified;
  verified = { ...verified, [target]: next };
  verifiedVersion++;
  verifiedListeners.forEach((l) => l());
}

/** 当前要下发的观察点规格（只含启用项；条件字段原样带，空白已在入库时清掉）。 */
export function watchpointSpecs(): DataBreakpointSpec[] {
  return getWatchpoints()
    .filter(isWatchpointEnabled)
    .map((w) => {
      const spec: DataBreakpointSpec = { dataId: w.dataId, accessType: w.accessType };
      if (w.condition) spec.condition = w.condition;
      if (w.hitCondition) spec.hitCondition = w.hitCondition;
      return spec;
    });
}

/** 下发签名：任一字段变化都要重发。 */
export const watchpointSig = (specs: DataBreakpointSpec[]): string => JSON.stringify(specs);

/** 每个目标上次成功下发的签名；null = 这个目标还没发过（连空清单都没发）。 */
const synced = new Map<DebugTarget, string | null>(
  DEBUG_TARGETS.map((t) => [t, null] as const),
);
let syncing = false;
let dirty = false;
let attachedTargets: (() => DebugTarget[]) | null = null;

export async function syncWatchpoints(): Promise<void> {
  const targets = attachedTargets?.() ?? [];
  if (targets.length === 0) return;
  if (syncing) {
    dirty = true;
    return;
  }
  syncing = true;
  try {
    const specs = watchpointSpecs();
    const sig = watchpointSig(specs);
    const dataIds = specs.map((s) => s.dataId);
    for (const target of targets) {
      // 没发过 + 空清单 = 没什么可做的：不给适配器添一次无意义的请求
      if (synced.get(target) === sig) continue;
      if (specs.length === 0 && synced.get(target) === null) continue;
      try {
        const r = await debugSetDataBreakpoints(target, specs);
        applyWatchpointVerified(target, dataIds, r.breakpoints);
        synced.set(target, sig);
      } catch {
        // 下一轮再试：不写 synced，避免把失败记成「已同步」
      }
    }
  } finally {
    syncing = false;
    if (dirty) {
      dirty = false;
      void syncWatchpoints();
    }
  }
}

/** 挂上观察点订阅（幂等）。`attached` 由会话状态提供，避免这里又存一份。 */
export function startWatchpointSync(attached: () => DebugTarget[]): void {
  if (attachedTargets) return;
  attachedTargets = attached;
  subscribeWatchpoints(() => {
    void syncWatchpoints();
  });
}

/**
 * 测试钩子：清掉 attached 回调与全部同步状态。
 *
 * 模块级状态跨用例驻留，而 `startWatchpointSync` 按幂等设计不换回调——
 * 单测里要测「没附加」的分支就只能整体重置（debugSession 的
 * `__setDebugStatusForTest` 同一思路）。
 */
export function __resetWatchpointSyncForTest(): void {
  attachedTargets = null;
  syncing = false;
  dirty = false;
  for (const t of DEBUG_TARGETS) synced.set(t, null);
  verified = emptyVerified();
  verifiedVersion++;
  verifiedListeners.forEach((l) => l());
}

/**
 * 热替换之后重装观察点，返回重新下发的观察点数（没附加调试时为 0）。
 *
 * 与 `reinstallBreakpoints` 同一个病：JVM 重定义类时 JDI 请求可能失效，而适配器
 * 的 `setWatchpoints` 对「清单没变」的条目只改条件、不重装（字节码确认：只有
 * 新身份的 watchpoint 才走 install）。所以先发空集清掉、再发完整清单，
 * 逼出新对象重装。清空那一下不碰 verified——紧接着的整批重发会重写。
 */
export async function reinstallWatchpoints(target: DebugTarget): Promise<number> {
  if (!(attachedTargets?.() ?? []).includes(target)) return 0;
  for (let i = 0; syncing && i < 40; i++) await new Promise((r) => setTimeout(r, 50));
  syncing = true;
  try {
    const specs = watchpointSpecs();
    const dataIds = specs.map((s) => s.dataId);
    await debugSetDataBreakpoints(target, []);
    const r = await debugSetDataBreakpoints(target, specs);
    applyWatchpointVerified(target, dataIds, r.breakpoints);
    synced.set(target, watchpointSig(specs));
    return specs.length;
  } catch {
    // 下一轮普通同步再试：删掉签名，让它当成「没发过」
    synced.set(target, null);
    return 0;
  } finally {
    syncing = false;
    if (dirty) {
      dirty = false;
      void syncWatchpoints();
    }
  }
}

/** 断开/重新附加时丢掉签名与 verified：下一次附加整批重发。只清指定目标。 */
export function resetWatchpointSync(target?: DebugTarget): void {
  for (const t of target ? [target] : DEBUG_TARGETS) {
    synced.set(t, null);
    verified = { ...verified, [t]: {} };
  }
  verifiedVersion++;
  verifiedListeners.forEach((l) => l());
}
