/**
 * 命令使用记录：命令面板空查询时按「频率 × 新近度」排序，刚用过的命令排最前。
 * 只记 id 与次数 / 时间，不记参数；存在本机 localStorage，按机器各自积累。
 */
const KEY = "ncforge-cmd-usage";
const DAY = 86_400_000;
const MAX_ENTRIES = 80;

interface Entry {
  count: number;
  at: number;
}

type Store = Record<string, Entry>;

function read(): Store {
  try {
    if (typeof localStorage === "undefined") return {};
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!value || typeof value !== "object") return {};
    const out: Store = {};
    for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const { count, at } = entry as Partial<Entry>;
      if (typeof count !== "number" || typeof at !== "number" || count <= 0) continue;
      out[id] = { count, at };
    }
    return out;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* 配额 / 隐私模式：不记即可，命令面板仍按登记顺序列出 */
  }
}

/** 近期用得越多分越高；30 天以上只剩 0.1 权重，避免老习惯永远压住新命令。 */
function score(entry: Entry, now: number): number {
  const days = Math.max(0, now - entry.at) / DAY;
  const recency = days < 1 ? 1 : days < 7 ? 0.6 : days < 30 ? 0.3 : 0.1;
  return Math.log2(1 + entry.count) * recency;
}

export function recordCommandUse(id: string, now = Date.now()): void {
  const store = read();
  const prev = store[id];
  store[id] = { count: (prev?.count ?? 0) + 1, at: now };
  const ids = Object.keys(store);
  if (ids.length > MAX_ENTRIES) {
    ids
      .sort((a, b) => store[a].at - store[b].at)
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((old) => delete store[old]);
  }
  write(store);
}

/** 最近常用命令的 id（最多 limit 个）。 */
export function recentCommandIds(now = Date.now(), limit = 6): string[] {
  return Object.entries(read())
    .map(([id, entry]) => ({ id, score: score(entry, now), at: entry.at }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, limit)
    .map((x) => x.id);
}
