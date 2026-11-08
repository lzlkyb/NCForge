/**
 * 打开标签的跨重启快照，按工作区分别存。
 *
 * 只存「哪些文件开着、哪个在前台、有没有分屏」——文件正文永远以磁盘为准：
 * 没保存的改动本来就不会跨进程存活，存正文反而会造出「看起来有、其实没落盘」的假象。
 */
const KEY = "ncforge-open-tabs";
const MAX_TABS = 20;

export interface TabSnapshot {
  tabs: string[];
  activePath: string | null;
  splitPath: string | null;
}

type Store = Record<string, TabSnapshot>;

let cachedRaw: string | null | undefined;
let cachedStore: Store = {};

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === cachedRaw) return { ...cachedStore };
    const v = JSON.parse(raw ?? "{}");
    cachedRaw = raw;
    cachedStore = v && typeof v === "object" && !Array.isArray(v) ? v as Store : {};
    return { ...cachedStore };
  } catch {
    return {};
  }
}

/** 只接受磁盘文件的快照：`jdt://` 类重开时会走另一条读源码的链路，这里不处理。 */
function validPaths(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((p): p is string => typeof p === "string" && !p.startsWith("jdt://")).slice(0, MAX_TABS)
    : [];
}

export function readTabSnapshot(root: string): TabSnapshot | null {
  const raw = load()[root.toLowerCase()];
  if (!raw || typeof raw !== "object") return null;
  const tabs = validPaths(raw.tabs);
  if (tabs.length === 0) return null;
  const activePath = typeof raw.activePath === "string" && tabs.includes(raw.activePath) ? raw.activePath : tabs[0];
  const splitPath = typeof raw.splitPath === "string" && tabs.includes(raw.splitPath) ? raw.splitPath : null;
  return { tabs, activePath, splitPath };
}

export function saveTabSnapshot(root: string, snap: TabSnapshot): void {
  const store = load();
  // Bound retained workspace snapshots as well as tabs within one workspace.
  delete store[root.toLowerCase()];
  const roots = Object.keys(store);
  for (const old of roots.slice(0, Math.max(0, roots.length - 19))) delete store[old];
  const tabs = validPaths(snap.tabs);
  store[root.toLowerCase()] =
    tabs.length === 0
      ? { tabs: [], activePath: null, splitPath: null }
      : {
          tabs,
          activePath: snap.activePath && tabs.includes(snap.activePath) ? snap.activePath : tabs[0],
          splitPath: snap.splitPath && tabs.includes(snap.splitPath) ? snap.splitPath : null,
        };
  try {
    const raw = JSON.stringify(store);
    localStorage.setItem(KEY, raw);
    cachedRaw = raw;
    cachedStore = store;
  } catch {
    /* 配额 / 隐私模式：只是不记 */
  }
}
