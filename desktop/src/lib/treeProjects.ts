import { invoke } from "./tauri";
import type { LinkedProject } from "./linkedProjects";

/**
 * 文件树要并排显示的工程根。
 *
 * 与 `linkedProjects()` 的区别是**不读 NC home**：树只关心工程根，而 NC home 只是
 * 类路径目录统计的来源。没配 NC home 的机器上走 `linked_projects` 会整体失败，
 * 多工程树就退化成单工程。
 */
export const treeProjects = () => invoke<LinkedProject[]>("tree_projects");

/** 只保留磁盘上存在的工程根（`.classpath` 写了但目录不在的条目没有可展开的东西）。 */
export function resolvableProjects(list: LinkedProject[]): LinkedProject[] {
  const seen = new Set<string>();
  const out: LinkedProject[] = [];
  for (const p of list) {
    if (!p.root) continue;
    const key = p.root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** `path` 是否在 `root` 里（含 root 自身）。Windows 路径不分大小写。 */
export function isUnderPath(path: string, root: string): boolean {
  const p = path.toLowerCase();
  const r = root.toLowerCase();
  return p === r || p.startsWith(r.endsWith("\\") ? r : `${r}\\`);
}

/**
 * 路径所属的工程。根互相嵌套时取**最长**的那个：`C:\w\newar` 与 `C:\w\newar\modules`
 * 同时命中时应归给更具体的工程，否则行会显示成另一个工程的文件。
 */
export function projectForPath(
  path: string,
  projects: LinkedProject[],
): LinkedProject | undefined {
  let best: LinkedProject | undefined;
  for (const p of projects) {
    if (!p.root || !isUnderPath(path, p.root)) continue;
    if (!best?.root || p.root.length > best.root.length) best = p;
  }
  return best;
}
