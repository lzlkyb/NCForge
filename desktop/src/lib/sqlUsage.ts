/** SQL 补全的本机偏好。只保存对象身份和使用信号，不复制 SQL 正文或结果。 */
export type SqlUsageEvent = "accept" | "type" | "execute";
export interface SqlUsageEntry {
  readonly score: number;
  readonly lastUsed: number;
  readonly count: number;
  readonly accept: number;
  readonly type: number;
  readonly execute: number;
  readonly pinned: boolean;
}
export type SqlUsageSnapshot = Readonly<Record<string, SqlUsageEntry>>;
export interface SqlUsageReceipt {
  readonly scope: string;
  readonly key: string;
  readonly before?: SqlUsageEntry;
  readonly after: SqlUsageEntry;
}
interface UsageStore { version: 1; enabled: boolean; scopes: Record<string, SqlUsageSnapshot> }

const STORAGE_KEY = "ncforge-sql-usage";
const MAX_PER_SCOPE = 1000, MAX_TOTAL = 6000, MAX_SCOPES = 64;
const HALF_LIFE = 14 * 86400000, HOUR = 3600000;
const WEIGHTS: Record<SqlUsageEvent, number> = { accept: 3, type: .5, execute: 2 };
const EMPTY: SqlUsageSnapshot = Object.freeze({});
let cache: UsageStore | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let hooked = false;
const listeners = new Set<() => void>();
const seen = new Map<string, number>();

/** 稳定身份在记忆里只保留双哈希；JDBC URL 偶尔含口令，不能原样写进偏好。 */
export function sqlUsageScope(connectionIdentity: string, schema = ""): string {
  let a = 2166136261, b = 2246822519;
  for (let i = 0; i < connectionIdentity.length; i++) {
    a = Math.imul(a ^ connectionIdentity.charCodeAt(i), 16777619);
    b = Math.imul(b ^ connectionIdentity.charCodeAt(i), 3266489917);
  }
  return JSON.stringify([(a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0"), schema]);
}

/** 调用者按方言规范标识符；这里保留大小写，避免合并带引号的不同对象。 */
export function sqlUsageKey(table: string, field?: string, clause?: string): string {
  return JSON.stringify([table, field ?? "", clause ?? ""]);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validEntry(value: unknown): value is SqlUsageEntry {
  if (!object(value) || typeof value.pinned !== "boolean") return false;
  return ["score", "lastUsed", "count", "accept", "type", "execute"].every(key =>
    typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0,
  ) && (value.score as number) <= 10000 && (value.lastUsed as number) <= Date.now() + 86400000
    && ["count", "accept", "type", "execute"].every(key => Number.isInteger(value[key]) && (value[key] as number) <= 1000000);
}
function validIdentity(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !["__proto__", "prototype", "constructor"].includes(value);
}
function read(): UsageStore {
  if (cache) return cache;
  cache = { version: 1, enabled: true, scopes: {} };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!object(raw) || raw.version !== 1 || !object(raw.scopes)) return cache;
    const scopes: Record<string, SqlUsageSnapshot> = {};
    for (const [scope, entries] of Object.entries(raw.scopes)) {
      if (!validIdentity(scope, 512) || !object(entries)) continue;
      const valid = Object.fromEntries(Object.entries(entries).filter(([key, value]) => validIdentity(key, 1024) && validEntry(value)));
      if (Object.keys(valid).length) scopes[scope] = valid as SqlUsageSnapshot;
    }
    cache = trim({ version: 1, enabled: typeof raw.enabled === "boolean" ? raw.enabled : true, scopes });
  } catch {
    // 私密模式或损坏 JSON 只影响偏好，不应影响 SQL 输入。
  }
  return cache;
}

function trim(store: UsageStore): UsageStore {
  const scopeNames = Object.keys(store.scopes);
  const records = scopeNames.flatMap(scope => Object.entries(store.scopes[scope]).map(([key, entry]) => ({ scope, key, entry })));
  if (scopeNames.length <= MAX_SCOPES && records.length <= MAX_TOTAL && scopeNames.every(scope => Object.keys(store.scopes[scope]).length <= MAX_PER_SCOPE)) return store;
  // 固定项优先保留，但仍有硬上限，避免偏好存储随长时间使用无限增长。
  records.sort((a, b) => Number(b.entry.pinned) - Number(a.entry.pinned) || b.entry.lastUsed - a.entry.lastUsed);
  const scopes: Record<string, Record<string, SqlUsageEntry>> = {};
  const counts = new Map<string, number>();
  let retained = 0;
  for (const { scope, key, entry } of records) {
    if (retained >= MAX_TOTAL) break;
    const count = counts.get(scope) ?? 0;
    if (count >= MAX_PER_SCOPE || (!count && counts.size >= MAX_SCOPES)) continue;
    (scopes[scope] ??= {})[key] = entry;
    counts.set(scope, count + 1); retained++;
  }
  return { ...store, scopes };
}

export function flushSqlUsage(): boolean {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!cache) return true;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); return true; }
  catch { return false; }
}
function scheduleWrite(): void {
  if (!hooked && typeof window !== "undefined") {
    hooked = true;
    window.addEventListener("pagehide", flushSqlUsage);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSqlUsage(); });
  }
  if (!writeTimer) writeTimer = setTimeout(flushSqlUsage, 300);
}
function publish(next: UsageStore, immediate = false): boolean {
  cache = trim(next);
  let saved = true;
  if (immediate) saved = flushSqlUsage(); else scheduleWrite();
  listeners.forEach(fn => fn());
  return saved;
}
export function subscribeSqlUsage(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function usageSnapshot(scope: string): SqlUsageSnapshot {
  const scopes = read().scopes;
  return Object.prototype.hasOwnProperty.call(scopes, scope) ? scopes[scope] : EMPTY;
}
export function getSqlUsageEnabled(): boolean { return read().enabled; }
export function setSqlUsageEnabled(enabled: boolean): boolean {
  const store = read();
  return publish({ ...store, enabled }, true);
}
function decayed(entry: SqlUsageEntry, now: number): number {
  return entry.score * Math.pow(.5, Math.max(0, now - entry.lastUsed) / HALF_LIFE);
}

/** 同一批执行/输入用 eventToken 去重；未提供时短时间封顶，防止回放脚本污染排序。 */
export function recordSqlUsage(scope: string, key: string, event: SqlUsageEvent, eventToken?: string): SqlUsageReceipt | null {
  const store = read();
  if (!store.enabled || !validIdentity(scope, 512) || !validIdentity(key, 1024)) return null;
  const now = Date.now(), stamp = JSON.stringify([scope, key, event, eventToken ?? ""]);
  const priorSeen = seen.get(stamp);
  if (priorSeen !== undefined && (eventToken !== undefined || now - priorSeen < (event === "accept" ? 500 : 30000))) return null;
  seen.set(stamp, now);
  while (seen.size > MAX_TOTAL) seen.delete(seen.keys().next().value!);
  const before = store.scopes[scope]?.[key];
  const zero: SqlUsageEntry = { score: 0, lastUsed: 0, count: 0, accept: 0, type: 0, execute: 0, pinned: false };
  const old = before ?? zero;
  const after: SqlUsageEntry = { ...old, score: Math.min(10000, decayed(old, now) + WEIGHTS[event]), lastUsed: now,
    count: Math.min(1000000, old.count + 1), [event]: Math.min(1000000, old[event] + 1) };
  publish({ ...store, scopes: { ...store.scopes, [scope]: { ...store.scopes[scope], [key]: after } } });
  return { scope, key, before, after };
}

/** 只撤回尚未发生后续修改的接受事件，避免一次撤销覆盖新的使用或用户固定操作。 */
export function rollbackSqlUsage(receipt: SqlUsageReceipt): boolean {
  const store = read(), entries = store.scopes[receipt.scope];
  if (entries?.[receipt.key] !== receipt.after) return false;
  const next = { ...entries };
  if (receipt.before) next[receipt.key] = receipt.before; else delete next[receipt.key];
  const scopes = { ...store.scopes };
  if (Object.keys(next).length) scopes[receipt.scope] = next; else delete scopes[receipt.scope];
  publish({ ...store, scopes });
  for (const stamp of [...seen.keys()]) {
    const parts: string[] = JSON.parse(stamp);
    if (parts[0] === receipt.scope && parts[1] === receipt.key) seen.delete(stamp);
  }
  return true;
}
export function setSqlUsagePinned(scope: string, key: string, pinned: boolean): boolean {
  if (!validIdentity(scope, 512) || !validIdentity(key, 1024)) return false;
  const store = read(), old = store.scopes[scope]?.[key];
  if (!old && !pinned) return true;
  const entry = { ...(old ?? { score: 0, lastUsed: 0, count: 0, accept: 0, type: 0, execute: 0 }), pinned };
  return publish({ ...store, scopes: { ...store.scopes, [scope]: { ...store.scopes[scope], [key]: entry } } }, true);
}
export function forgetSqlUsage(scope: string, key: string): boolean {
  if (!validIdentity(scope, 512) || !validIdentity(key, 1024)) return false;
  const store = read(), entries = store.scopes[scope];
  if (!entries?.[key]) return true;
  const next = { ...entries }; delete next[key];
  const scopes = { ...store.scopes };
  if (Object.keys(next).length) scopes[scope] = next; else delete scopes[scope];
  for (const stamp of [...seen.keys()]) { const parts: string[] = JSON.parse(stamp); if (parts[0] === scope && parts[1] === key) seen.delete(stamp); }
  return publish({ ...store, scopes }, true);
}
export function clearSqlUsage(scope: string): boolean {
  if (!validIdentity(scope, 512)) return false;
  const store = read(), scopes = { ...store.scopes }; delete scopes[scope];
  for (const stamp of [...seen.keys()]) { const parts: string[] = JSON.parse(stamp); if (parts[0] === scope) seen.delete(stamp); }
  return publish({ ...store, scopes }, true);
}

/** 只在相同匹配等级内比较此值。第一小时明显偏向近期，其后以衰减频率稳定兜底。 */
export function sqlUsageRank(scope: string, key: string, now = Date.now()): number {
  if (!getSqlUsageEnabled() || !validIdentity(key, 1024)) return 0;
  const entry = usageSnapshot(scope)[key];
  if (!entry) return 0;
  const age = Math.max(0, now - entry.lastUsed);
  const recent = entry.lastUsed && age < HOUR ? 1e9 + Math.floor((HOUR - age) / 1000) * 10000 : 0;
  return (entry.pinned ? 1e12 : 0) + recent + Math.min(1000, decayed(entry, now)) * 10;
}
export function sqlUsageReason(scope: string, key: string, now = Date.now()): string {
  if (!getSqlUsageEnabled() || !validIdentity(key, 1024)) return "";
  const entry = usageSnapshot(scope)[key];
  if (!entry) return "";
  if (entry.pinned) return "已固定";
  if (entry.lastUsed && now - entry.lastUsed < HOUR) return "最近使用";
  return decayed(entry, now) >= 3 ? "常用" : "";
}
