/**
 * 执行历史：按连接记在本机（localStorage），每个连接最近 500 条，不上传。
 *
 * 读写都包 try/catch：隐私模式或存储满时历史丢了不要紧，但不能让执行本身报错。
 */

export interface HistoryEntry {
  at: number;
  sql: string;
  ms: number;
  /** 「500+ 行」「更新 1 行」「ORA-00942」之类的一句话结果。 */
  summary: string;
  ok: boolean;
}

const KEY = "ncforge-db-history";
const MAX = 500;

// 读一次缓存起来：useSyncExternalStore 要求没变化时返回同一个数组引用，否则会无限重渲染
let cache: Record<string, HistoryEntry[]> | null = null;

function readAll(): Record<string, HistoryEntry[]> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    cache = v && typeof v === "object" ? (v as Record<string, HistoryEntry[]>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

const listeners = new Set<() => void>();

export function subscribeHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const NONE: HistoryEntry[] = [];

export function getHistory(connId: string): HistoryEntry[] {
  return readAll()[connId] ?? NONE;
}

export function addHistory(connId: string, entry: HistoryEntry): void {
  const all = readAll();
  const list = [entry, ...(all[connId] ?? []).filter((e) => e.sql !== entry.sql)].slice(0, MAX);
  all[connId] = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存不下就算了
  }
  listeners.forEach((fn) => fn());
}

export function clearHistory(connId: string): void {
  const all = readAll();
  delete all[connId];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 忽略
  }
  listeners.forEach((fn) => fn());
}

/** 搜索：所有关键词都出现在 SQL 里（不分大小写）。 */
export function filterHistory(list: HistoryEntry[], query: string): HistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return list;
  return list.filter((e) => {
    const s = e.sql.toLowerCase();
    return words.every((w) => s.includes(w));
  });
}

/** 「10:42」「昨天 17:20」「10-27 09:05」。 */
export function historyTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime()) return hm;
  if (at >= today.getTime() - 86_400_000) return `昨天 ${hm}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}
