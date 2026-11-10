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

/** 合并写盘的延迟：回放脚本几百条语句时，只在主线程空闲时序列化一次历史。 */
const WRITE_DELAY_MS = 300;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 立刻把内存里的历史写进 localStorage。
 *
 * 平时不必调：`addHistory` 只更新内存 + 通知，300ms 内合并写一次。但页面要走了
 * （`pagehide` / 隐藏）时得补写，否则最后几条执行记录会随进程一起消失。
 */
export function flushHistory(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!cache) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // 存不下就算了
  }
}

let hooked = false;
function scheduleWrite(): void {
  if (!hooked && typeof window !== "undefined") {
    hooked = true;
    // 浏览器/WebView 关闭前不一定还有定时器机会，补一次同步写。
    window.addEventListener("pagehide", flushHistory);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushHistory();
    });
  }
  if (writeTimer) return;
  writeTimer = setTimeout(flushHistory, WRITE_DELAY_MS);
}

export function subscribeHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 全部连接的原始映射（引用稳定，可直接喂给 `useSyncExternalStore`）。
 * 「搜历史」默认只搜当前连接，但常有人记得「那条 SQL 我在另一个库上跑过」——
 * 全局搜就是拿这个映射在组件里摊平。
 */
export function getHistoryMap(): Readonly<Record<string, HistoryEntry[]>> {
  return readAll();
}

export function addHistory(connId: string, entry: HistoryEntry): void {
  const all = readAll();
  const list = [entry, ...(all[connId] ?? []).filter((e) => e.sql !== entry.sql)].slice(0, MAX);
  // 不能就地改 `all`：`getHistoryMap()` 把同一个对象直接交给 useSyncExternalStore，
  // 引用不变就被判成「没变化」，历史抽屉里的列表永远不刷新。每次换一个新对象。
  cache = { ...all, [connId]: list };
  // 列表立刻可见（内存 + 通知），落盘合并到 300ms：几百条 INSERT 的回放不再逐条全量序列化。
  scheduleWrite();
  listeners.forEach((fn) => fn());
}

export function clearHistory(connId: string): void {
  const all = readAll();
  if (!(connId in all)) return;
  const next = { ...all };
  delete next[connId];
  cache = next;
  // 清空是用户的明确动作，必须立即落盘：否则 300ms 内退出会把刚清掉的历史又带回来。
  flushHistory();
  listeners.forEach((fn) => fn());
}

/** 一条命中：哪条连接的哪次执行。跨连接搜索时要靠 `connId` 标出来源。 */
export interface HistoryHit {
  connId: string;
  entry: HistoryEntry;
}

/**
 * 把「某连接」或「全部连接」的历史摊平成一条按时间倒序的列表。
 *
 * 单连接时直接取那条（顺序本来就是新的在前）；全部时把各连接的记录混起来重排——
 * 用户记得的是「上午跑过」，不是「在 A 库跑过」，所以不能按连接分组显示。
 */
export function historyHits(map: Readonly<Record<string, HistoryEntry[]>>, connId: string | null, all: boolean): HistoryHit[] {
  if (!all) {
    const list = connId ? (map[connId] ?? []) : [];
    return list.map((entry) => ({ connId: connId ?? "", entry }));
  }
  const out: HistoryHit[] = [];
  for (const [id, list] of Object.entries(map)) for (const entry of list) out.push({ connId: id, entry });
  return out.sort((a, b) => b.entry.at - a.entry.at);
}

/**
 * 搜索：所有关键词都出现（不分大小写）。**SQL 与结果摘要一起搜**——「哪次报了 ORA-00942」
 * 这种找法只能靠摘要，只看 SQL 文本永远搜不到错误码。`failOnly` 是排障时的第一步。
 */
export function filterHits(hits: HistoryHit[], query: string, failOnly = false): HistoryHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return hits.filter((h) => {
    if (failOnly && h.entry.ok) return false;
    if (words.length === 0) return true;
    const hay = `${h.entry.sql}\n${h.entry.summary}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * 命中区间（用于高亮）：把每个关键词在文本里出现的位置找出来，重叠的合并。
 * 不做正则——关键词里有 `(` `*` `$` 这类字符时，正则要么炸要么匹配错。
 */
export function matchRanges(text: string, query: string): { start: number; end: number }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const low = text.toLowerCase();
  const hits: { start: number; end: number }[] = [];
  for (const w of words) {
    let i = low.indexOf(w);
    while (i >= 0) {
      hits.push({ start: i, end: i + w.length });
      i = low.indexOf(w, i + w.length);
    }
  }
  if (hits.length === 0) return [];
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number }[] = [hits[0]];
  for (const h of hits.slice(1)) {
    const last = out[out.length - 1];
    if (h.start <= last.end) last.end = Math.max(last.end, h.end);
    else out.push(h);
  }
  return out;
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
