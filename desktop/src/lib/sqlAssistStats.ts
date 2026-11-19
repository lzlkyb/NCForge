/**
 * SQL 补全质量的本机测量（先有数，再谈剪枝）。
 *
 * 只记两个问题的答案：
 * 1. 一次补全有没有在时间预算内拿到元数据——`early()` 的等待/超时计数，
 *    按预算档分（自动触发 120ms / 手动 Ctrl+空格 500ms）。
 * 2. 各建议源端出来多少、被接受多少——曝光在 provider 出口按 `ncforgeSource`
 *    标签计数，接受走补全项的 command 通道（Monaco 0.52 没有接受事件）。
 *
 * 纪律与 `sqlUsage` 同源：只存计数，不存 SQL 正文、不存对象名、不存连接身份；
 * 本机 localStorage、防抖落盘、pagehide 兜底；损坏 JSON 静默重置。
 * 带后续动作的条目（选字段、唤起菜单）只计曝光不计接受——它们的 command
 * 已被占用，口径在设置页明示。
 */

export const ASSIST_SOURCES = [
  "table", "column", "predicate", "time", "template", "billjoin", "join", "joinhistory",
  "condition", "enum", "related", "archive", "snippet", "function", "keyword",
  "alias", "projection", "cte", "derived", "action",
] as const;
export type AssistSource = typeof ASSIST_SOURCES[number];
const SOURCE_SET = new Set<string>(ASSIST_SOURCES);

export interface AssistSourceStat { readonly offers: number; readonly accepts: number }
export interface AssistEarlyStat { readonly waits: number; readonly timeouts: number }
export interface AssistStatsSnapshot {
  readonly enabled: boolean;
  readonly calls: { readonly auto: number; readonly invoke: number };
  readonly early: { readonly auto: AssistEarlyStat; readonly invoke: AssistEarlyStat };
  readonly sources: Readonly<Record<string, AssistSourceStat>>;
}
interface StatsStore {
  version: 1; enabled: boolean;
  calls: { auto: number; invoke: number };
  early: { auto: { waits: number; timeouts: number }; invoke: { waits: number; timeouts: number } };
  sources: Record<string, { offers: number; accepts: number }>;
}

const STORAGE_KEY = "ncforge-sql-assist-stats";
const MAX_COUNT = 1_000_000;
let cache: StatsStore | null = null;
let snapshotCache: AssistStatsSnapshot | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let hooked = false;
const listeners = new Set<() => void>();

function fresh(): StatsStore {
  return { version: 1, enabled: true, calls: { auto: 0, invoke: 0 },
    early: { auto: { waits: 0, timeouts: 0 }, invoke: { waits: 0, timeouts: 0 } }, sources: {} };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT ? value : 0;
}
function readEarly(value: unknown): { waits: number; timeouts: number } {
  if (!object(value)) return { waits: 0, timeouts: 0 };
  const waits = count(value.waits), timeouts = Math.min(count(value.timeouts), waits);
  return { waits, timeouts };
}
function read(): StatsStore {
  if (cache) return cache;
  cache = fresh();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!object(raw) || raw.version !== 1) return cache;
    const calls = object(raw.calls) ? raw.calls : {};
    const early = object(raw.early) ? raw.early : {};
    const sources: StatsStore["sources"] = {};
    if (object(raw.sources)) {
      for (const [key, value] of Object.entries(raw.sources)) {
        if (!SOURCE_SET.has(key) || !object(value)) continue;
        const offers = count(value.offers), accepts = Math.min(count(value.accepts), offers);
        if (offers || accepts) sources[key] = { offers, accepts };
      }
    }
    cache = { version: 1, enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      calls: { auto: count(calls.auto), invoke: count(calls.invoke) },
      early: { auto: readEarly(early.auto), invoke: readEarly(early.invoke) }, sources };
  } catch {
    // 私密模式或损坏 JSON 只影响统计，不应影响 SQL 输入。
  }
  return cache;
}

export function flushAssistStats(): boolean {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!cache) return true;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); return true; }
  catch { return false; }
}
function scheduleWrite(): void {
  if (!hooked && typeof window !== "undefined") {
    hooked = true;
    window.addEventListener("pagehide", flushAssistStats);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushAssistStats(); });
  }
  if (!writeTimer) writeTimer = setTimeout(flushAssistStats, 300);
}
function publish(next: StatsStore, immediate = false): boolean {
  cache = next;
  snapshotCache = null;
  let saved = true;
  if (immediate) saved = flushAssistStats(); else scheduleWrite();
  listeners.forEach(fn => fn());
  return saved;
}
export function subscribeAssistStats(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
/** useSyncExternalStore 要求快照引用稳定：store 不变就返回同一对象，否则无限重渲染。 */
export function assistStatsSnapshot(): AssistStatsSnapshot {
  if (snapshotCache) return snapshotCache;
  const store = read();
  snapshotCache = { enabled: store.enabled, calls: { ...store.calls },
    early: { auto: { ...store.early.auto }, invoke: { ...store.early.invoke } },
    sources: Object.fromEntries(Object.entries(store.sources).map(([key, value]) => [key, { ...value }])) };
  return snapshotCache;
}
export function getAssistStatsEnabled(): boolean { return read().enabled; }
export function setAssistStatsEnabled(enabled: boolean): boolean {
  return publish({ ...read(), enabled }, true);
}
export function clearAssistStats(): boolean {
  return publish({ ...fresh(), enabled: read().enabled }, true);
}

const bump = (value: number): number => Math.min(MAX_COUNT, value + 1);
export function recordAssistCall(kind: "auto" | "invoke"): void {
  const store = read();
  if (!store.enabled) return;
  publish({ ...store, calls: { ...store.calls, [kind]: bump(store.calls[kind]) } });
}
/** `early()` 每次等待记一条；超时 = 预算内没拿到元数据，回退值端了出去。 */
export function recordAssistEarly(budget: number, timedOut: boolean): void {
  const store = read();
  if (!store.enabled) return;
  const bucket = budget >= 400 ? "invoke" : "auto";
  const prev = store.early[bucket];
  publish({ ...store, early: { ...store.early, [bucket]: { waits: bump(prev.waits), timeouts: timedOut ? bump(prev.timeouts) : prev.timeouts } } });
}
/** provider 出口按标签计曝光；无标签（提示/加载中/动作提示行）不计。 */
export function recordAssistOffers(items: readonly { ncforgeSource?: string }[]): void {
  const store = read();
  if (!store.enabled) return;
  const tally = new Map<string, number>();
  for (const item of items) {
    const source = item.ncforgeSource;
    if (typeof source === "string" && SOURCE_SET.has(source)) tally.set(source, (tally.get(source) ?? 0) + 1);
  }
  if (!tally.size) return;
  const sources = { ...store.sources };
  for (const [source, n] of tally) {
    const prev = sources[source] ?? { offers: 0, accepts: 0 };
    sources[source] = { offers: Math.min(MAX_COUNT, prev.offers + n), accepts: prev.accepts };
  }
  publish({ ...store, sources });
}
export function recordAssistAccept(source: string): void {
  const store = read();
  if (!store.enabled || !SOURCE_SET.has(source)) return;
  const prev = store.sources[source];
  // 没有曝光记录的接受不入账：旧版本列表残留或伪造 command 不该造出 >100% 的接受率。
  if (!prev || prev.accepts >= prev.offers) return;
  publish({ ...store, sources: { ...store.sources, [source]: { offers: prev.offers, accepts: prev.accepts + 1 } } });
}

export interface AssistSourceSummary { source: AssistSource; offers: number; accepts: number; rate: number }
/** 纯函数汇总：接受率 = accepts/offers；只列有曝光的源，按曝光降序。 */
export function summarizeAssistStats(snapshot: AssistStatsSnapshot): {
  early: { bucket: "auto" | "invoke"; waits: number; timeouts: number; okRate: number }[];
  sources: AssistSourceSummary[];
} {
  const early = (["auto", "invoke"] as const).map(bucket => {
    const { waits, timeouts } = snapshot.early[bucket];
    return { bucket, waits, timeouts, okRate: waits ? (waits - timeouts) / waits : 1 };
  });
  const sources = Object.entries(snapshot.sources)
    .filter((entry): entry is [AssistSource, AssistSourceStat] => SOURCE_SET.has(entry[0]) && entry[1].offers > 0)
    .map(([source, stat]) => ({ source, offers: stat.offers, accepts: stat.accepts, rate: stat.accepts / stat.offers }))
    .sort((a, b) => b.offers - a.offers || a.source.localeCompare(b.source));
  return { early, sources };
}