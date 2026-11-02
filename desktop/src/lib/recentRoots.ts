/**
 * 最近打开的工作区。空工程引导页与「更换工作区目录」都从这里取，
 * 免得用户每次重新输入一长串路径。
 *
 * 与 `recentFiles` 同一种存储方式（localStorage，读失败当空），
 * 但只有一份列表：工作区是全局的，不像文件按 root 分组。
 */
const KEY = "ncforge-recent-roots";
const MAX = 8;

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
  } catch {
    return [];
  }
}

function save(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* 配额 / 隐私模式：只是不记 */
  }
}

export function getRecentRoots(): string[] {
  return load();
}

/** 记住一个工作区：置顶、大小写不敏感去重。 */
export function rememberRoot(root: string): void {
  const path = root.trim();
  if (!path) return;
  const key = path.toLowerCase();
  save([path, ...load().filter((p) => p.toLowerCase() !== key)].slice(0, MAX));
}
