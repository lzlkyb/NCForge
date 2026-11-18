// 断点 ←→ 调试适配器的同步。
//
// 与 `debugSession.ts` 分开：那边管「会话停在哪、栈和变量是什么」，这边只管
// 「本地断点清单怎样落到适配器上」。两件事的触发源不同（用户点 gutter vs DAP 事件），
// 合在一个文件里会把两个状态机缠在一起。
//
// 中间件与客户端是两个独立 JVM：各自记一份「已下发签名」与 verified 状态。
// 一个断点只要在任一边落点成功就画实心圆——同一份源码的同一行，两边是否都能解析
// 由各自的 classpath 决定，不能因为客户端没这个类就把中间件的落点也涂掉。
import type { DebugTarget } from "./debug";
import { DEBUG_TARGETS } from "./debug";
import { bpKey, breakpointGroupSig, getBreakpoints, groupBreakpoints, isMuted, subscribeBreakpoints } from "./breakpoints";
import { debugSetBreakpoints } from "./debug";
import type { DapBreakpoint } from "./debug";

const emptyMap = (): Record<DebugTarget, Map<string, { path: string; sig: string }>> => ({
  server: new Map(),
  client: new Map(),
  remote: new Map(),
});

const emptyVerified = (): Record<DebugTarget, Record<string, boolean>> => ({
  server: {},
  client: {},
  remote: {},
});

let verified = emptyVerified();
const verifiedListeners = new Set<() => void>();

export function subscribeVerified(cb: () => void): () => void {
  verifiedListeners.add(cb);
  return () => {
    verifiedListeners.delete(cb);
  };
}

/** 某个断点是否在任一已附加的目标上落点（gutter 画空心圆用）。 */
export function isVerified(path: string, line: number): boolean {
  const key = bpKey(path, line);
  return DEBUG_TARGETS.some((t) => verified[t][key] === true);
}

function applyVerified(target: DebugTarget, path: string, list: DapBreakpoint[]): void {
  const next = { ...verified[target] };
  for (const b of list) {
    const p = b.source?.path ?? path;
    if (typeof b.line === "number") next[bpKey(p, b.line)] = !!b.verified;
  }
  verified = { ...verified, [target]: next };
  verifiedListeners.forEach((l) => l());
}

/** `breakpoint` 事件里回报的落点状态。 */
export function applyBreakpointEvent(target: DebugTarget, path: string, line: number, ok: boolean): void {
  verified = { ...verified, [target]: { ...verified[target], [bpKey(path, line)]: ok } };
  verifiedListeners.forEach((l) => l());
}

// 每个目标上次成功下发的「路径 + 行的签名」：附加成功后整批补发，之后只发变了的文件。
const synced = emptyMap();
let syncing = false;
let dirty = false;
let attachedTargets: (() => DebugTarget[]) | null = null;

const temporary = new Map<DebugTarget, { path: string; line: number }>();
function groupsForTarget(target: DebugTarget): ReturnType<typeof groupBreakpoints> {
  const extra = temporary.get(target);
  const items = getBreakpoints();
  // A logpoint or false condition is verified too, but cannot stop at the cursor.
  // Override only this target's outgoing rule and restore the stored rule on cleanup.
  if (extra) {
    return groupBreakpoints([
      ...items.filter((b) => bpKey(b.path, b.line) !== bpKey(extra.path, extra.line)),
      { ...extra, enabled: true },
    ]);
  }
  // 全局静音（Mute）：一个组都不发。下面「清空已同步文件」的分支会把适配器上的
  // 断点显式删掉；取消静音后签名对不上，整批重发——这正是 Mute 要的语义。
  // 临时断点不受静音影响：运行到光标处是明确的一次性动作。
  if (isMuted()) return new Map();
  return groupBreakpoints(items);
}

async function waitForSync(): Promise<void> {
  // A pending DAP request has a timeout. Do not interleave setBreakpoints lists.
  for (let n = 0; syncing && n < 400; n++) await new Promise(resolve => setTimeout(resolve, 50));
  if (syncing) throw new Error("断点正在同步，请稍后重试");
}
function invalidateTemporaryFile(target: DebugTarget, path: string): void {
  const key = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  synced[target].set(key, { path, sig: "" });
  const next = { ...verified[target] };
  for (const item of Object.keys(next)) if (item.startsWith(`${key}#`)) delete next[item];
  verified = { ...verified, [target]: next };
}
export async function installTemporaryBreakpoint(target: DebugTarget, path: string, line: number): Promise<void> {
  if (!(attachedTargets?.() ?? []).includes(target)) throw new Error("该目标尚未附加调试器");
  await waitForSync();
  temporary.set(target, { path, line }); invalidateTemporaryFile(target, path);
  await syncBreakpoints();
  if (!verified[target][bpKey(path, line)]) {
    await clearTemporaryBreakpoint(target);
    throw new Error("目标行没有可执行代码或不在当前调试类路径中，未继续运行");
  }
}
export async function clearTemporaryBreakpoint(target: DebugTarget): Promise<void> {
  if (!temporary.has(target)) return;
  await waitForSync();
  const extra = temporary.get(target);
  if (!extra) return;
  temporary.delete(target); invalidateTemporaryFile(target, extra.path);
  await syncBreakpoints();
}

export async function syncBreakpoints(): Promise<void> {
  const targets = attachedTargets?.() ?? [];
  if (targets.length === 0) return;
  if (syncing) {
    dirty = true;
    return;
  }
  syncing = true;
  try {
    for (const target of targets) {
      const groups = groupsForTarget(target);
      const sent = synced[target];
      for (const [key, g] of groups) {
        const sig = breakpointGroupSig(g);
        if (sent.get(key)?.sig === sig) continue;
        try {
          const r = await debugSetBreakpoints(target, g.path, g.breakpoints);
          applyVerified(target, g.path, r.breakpoints ?? []);
          sent.set(key, { path: g.path, sig });
        } catch {
          // 下一轮再试：不写 synced，避免把失败记成「已同步」
        }
      }
      // 整个文件的断点都被清掉了：显式发一次空集合，适配器那边才会真删
      for (const [key, s] of [...sent]) {
        if (groups.has(key)) continue;
        try {
          await debugSetBreakpoints(target, s.path, []);
          sent.delete(key);
        } catch {
          // 同上
        }
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

/**
 * 热替换之后重装断点，返回重新下发的断点数（没附加调试时为 0）。
 *
 * JVM 重定义类时会清掉该类里的断点，而调试器不知道：它那边的请求还在，
 * 再发一次同样的清单会被适配器当成「没变」直接跳过。所以每个文件先发空集合、
 * 再发完整清单，逼它真的重新落点。
 */
export async function reinstallBreakpoints(target: DebugTarget): Promise<number> {
  if (!(attachedTargets?.() ?? []).includes(target)) return 0;
  // 正在跑的同步会写同一份签名表：等它结束（最多约 2 秒），避免两路交错。
  for (let i = 0; syncing && i < 40; i++) await new Promise((r) => setTimeout(r, 50));
  syncing = true;
  let count = 0;
  try {
    const sent = synced[target];
    for (const [key, g] of groupsForTarget(target)) {
      try {
        await debugSetBreakpoints(target, g.path, []);
        const r = await debugSetBreakpoints(target, g.path, g.breakpoints);
        applyVerified(target, g.path, r.breakpoints ?? []);
        sent.set(key, { path: g.path, sig: breakpointGroupSig(g) });
        count += g.breakpoints.length;
      } catch {
        // 下一轮普通同步再试：删掉签名，让它当成「没发过」
        sent.delete(key);
      }
    }
  } finally {
    syncing = false;
    if (dirty) {
      dirty = false;
      void syncBreakpoints();
    }
  }
  return count;
}

/** 挂上断点订阅（幂等）。`attached` 由会话状态提供，避免这里又存一份。 */
export function startBreakpointSync(attached: () => DebugTarget[]): void {
  if (attachedTargets) return;
  attachedTargets = attached;
  subscribeBreakpoints(() => {
    void syncBreakpoints();
  });
}

/** 断开/重新附加时丢掉签名：下一次附加要整批重发。只清指定目标，另一边不受影响。 */
export function resetBreakpointSync(target?: DebugTarget): void {
  for (const t of target ? [target] : DEBUG_TARGETS) {
    temporary.delete(t);
    synced[t].clear();
    verified = { ...verified, [t]: {} };
  }
  verifiedListeners.forEach((l) => l());
}
