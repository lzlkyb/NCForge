import { joinPath } from "./workspace";
import type { TreeDirState } from "./workspaceSession";

/** 树里一行（展平后的可见顺序），键盘上下移动按这个顺序。 */
export interface FlatRow {
  path: string;
  isDir: boolean;
  /** 所在目录行；顶层项为 null（根目录本身不占一行）。 */
  parent: string | null;
}

export interface TreeSelection {
  path: string;
  isDir: boolean;
}

export type TreeNavAction =
  | { kind: "select"; path: string; isDir: boolean }
  | { kind: "toggle"; path: string }
  | { kind: "open"; path: string };

/** 把已展开的目录按显示顺序摊平。键盘导航与 `aria-activedescendant` 都用它。 */
export function flattenTree(
  dirs: Record<string, TreeDirState>,
  expanded: Set<string>,
  root: string,
): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (dir: string, parent: string | null) => {
    const st = dirs[dir];
    if (!st || st.status !== "ok") return;
    for (const item of st.items) {
      const full = joinPath(dir, item.name);
      out.push({ path: full, isDir: item.isDir, parent });
      if (item.isDir && expanded.has(full)) walk(full, full);
    }
  };
  walk(root, null);
  return out;
}

/** `aria-activedescendant` 的目标 id。路径任意的字符都编码掉，保证是合法 id。 */
export const treeRowId = (path: string) => `wb-tree-row-${encodeURIComponent(path)}`;

/**
 * 方向键按 ARIA tree 的约定换算成动作：上下换行；右展开 / 进子目录；左收起 / 回父目录；
 * Home / End 跳首尾；Enter / 空格展开目录或打开文件。返回 null = 这个键不归导航管。
 */
export function treeKeyAction(
  key: string,
  flat: FlatRow[],
  selected: TreeSelection | null,
  expanded: Set<string>,
): TreeNavAction | null {
  const at = selected ? flat.findIndex((r) => r.path === selected.path) : -1;
  const selectAt = (i: number): TreeNavAction | null => {
    const r = flat[i];
    return r ? { kind: "select", path: r.path, isDir: r.isDir } : null;
  };
  switch (key) {
    case "ArrowDown":
      return selectAt(at < 0 ? 0 : Math.min(at + 1, flat.length - 1));
    case "ArrowUp":
      return selectAt(at < 0 ? 0 : Math.max(at - 1, 0));
    case "Home":
      return selectAt(0);
    case "End":
      return selectAt(flat.length - 1);
    case "ArrowRight":
      if (!selected) return selectAt(0);
      if (!selected.isDir) return null;
      if (!expanded.has(selected.path)) return { kind: "toggle", path: selected.path };
      return selectAt(flat.findIndex((r) => r.parent === selected.path));
    case "ArrowLeft": {
      if (!selected) return null;
      if (selected.isDir && expanded.has(selected.path)) {
        return { kind: "toggle", path: selected.path };
      }
      const row = flat[at];
      return row?.parent ? { kind: "select", path: row.parent, isDir: true } : null;
    }
    case "Enter":
    case " ":
      if (!selected) return null;
      return selected.isDir ? { kind: "toggle", path: selected.path } : { kind: "open", path: selected.path };
    default:
      return null;
  }
}
