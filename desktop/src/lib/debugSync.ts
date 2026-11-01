// 断点 ←→ 调试适配器的同步。
//
// 与 `debugSession.ts` 分开：那边管「会话停在哪、栈和变量是什么」，这边只管
// 「本地断点清单怎样落到适配器上」。两件事的触发源不同（用户点 gutter vs DAP 事件），
// 合在一个文件里会把两个状态机缠在一起。
import { bpKey, getBreakpoints, groupBreakpoints, subscribeBreakpoints } from "./breakpoints";
import { debugSetBreakpoints } from "./debug";
import type { DapBreakpoint } from "./debug";

let verified: Record<string, boolean> = {};
const verifiedListeners = new Set<() => void>();

export const getVerifiedMap = () => verified;

export function subscribeVerified(cb: () => void): () => void {
  verifiedListeners.add(cb);
  return () => {
    verifiedListeners.delete(cb);
  };
}

/** 某个断点适配器是否落点（gutter 画空心圆用）。 */
export function isVerified(path: string, line: number): boolean {
  return verified[bpKey(path, line)] === true;
}

function applyVerified(path: string, list: DapBreakpoint[]): void {
  const next = { ...verified };
  for (const b of list) {
    const p = b.source?.path ?? path;
    if (typeof b.line === "number") next[bpKey(p, b.line)] = !!b.verified;
  }
  verified = next;
  verifiedListeners.forEach((l) => l());
}

/** `breakpoint` 事件里回报的落点状态。 */
export function applyBreakpointEvent(path: string, line: number, ok: boolean): void {
  verified = { ...verified, [bpKey(path, line)]: ok };
  verifiedListeners.forEach((l) => l());
}

// 上次成功下发的「路径 + 行的签名」：附加成功后整批补发，之后只发变了的文件。
const synced = new Map<string, { path: string; sig: string }>();
let syncing = false;
let dirty = false;
let isAttached: (() => boolean) | null = null;

export async function syncBreakpoints(): Promise<void> {
  if (!isAttached?.()) return;
  if (syncing) {
    dirty = true;
    return;
  }
  syncing = true;
  try {
    const groups = groupBreakpoints(getBreakpoints());
    for (const [key, g] of groups) {
      const sig = g.lines.join(",");
      if (synced.get(key)?.sig === sig) continue;
      try {
        const r = await debugSetBreakpoints(g.path, g.lines);
        applyVerified(g.path, r.breakpoints ?? []);
        synced.set(key, { path: g.path, sig });
      } catch {
        // 下一轮再试：不写 synced，避免把失败记成「已同步」
      }
    }
    // 整个文件的断点都被清掉了：显式发一次空集合，适配器那边才会真删
    for (const [key, s] of [...synced]) {
      if (groups.has(key)) continue;
      try {
        await debugSetBreakpoints(s.path, []);
        synced.delete(key);
      } catch {
        // 同上
      }
    }
  } finally {
    syncing = false;
    if (dirty) {
      dirty = false;
      void syncBreakpoints();
    }
  }
}

/** 挂上断点订阅（幂等）。`attached` 由会话状态提供，避免这里又存一份。 */
export function startBreakpointSync(attached: () => boolean): void {
  if (isAttached) return;
  isAttached = attached;
  subscribeBreakpoints(() => {
    void syncBreakpoints();
  });
}

/** 断开/重新附加时丢掉签名：下一次附加要整批重发。 */
export function resetBreakpointSync(): void {
  synced.clear();
  verified = {};
  verifiedListeners.forEach((l) => l());
}
