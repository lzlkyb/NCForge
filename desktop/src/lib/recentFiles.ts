/**
 * 最近打开的文件，按工程分别记在 localStorage。
 * 空编辑器页和 Ctrl+P 的空查询都用它：刚用过的文件是最可能再要的。
 */
const KEY = "ncforge-recent-files";
const MAX = 20;

type Store = Record<string, string[]>;

function load(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Store) : {};
  } catch {
    return {};
  }
}

export function getRecent(root: string | null | undefined): string[] {
  return root ? (load()[root.toLowerCase()] ?? []) : [];
}

export function recordRecent(root: string | null | undefined, path: string): void {
  if (!root || path.startsWith("jdt://")) return;
  const key = root.toLowerCase();
  const store = load();
  const list = [path, ...(store[key] ?? []).filter((p) => p.toLowerCase() !== path.toLowerCase())];
  store[key] = list.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* 配额 / 隐私模式：只是不记 */
  }
}
