import { joinPath } from "./workspace";
import { chainOpen, dirChain } from "./treeCompact";
import { packageChildren, packageCompact, type PackageRoots, type PackageIndexes } from "./packageTree";
import { hasJavaMembers, type TreeMembers } from "./javaTreeMembers";
import type { TreeDirState } from "./workspaceSession";

/** 树里一行（展平后的可见顺序），键盘上下移动按这个顺序。 */
export interface FlatRow {
  path: string;
  isDir: boolean;
  /** 所在目录行；顶层项为 null（单工程时根目录本身不占一行）。 */
  parent: string | null;
  /**
   * 真实所在目录。只有 NC 结构视图摊平后才与 `parent` 不同：`bill/src/public`
   * 显示在 `bill` 下面（`parent` = bill），真身在 `bill/src` 下。
   *
   * 展开 / 收起必须拿它去问压缩链（`chainFor` 在真实父目录里找这一行）；
   * 而方向键的「左回父目录」「右进子项」要看得到的那一层，所以用 `parent`。
   */
  realParent?: string;
  /** 显示名。压缩中间包时会变成 `com.aier.erp`（省略时用路径末段）。 */
  label?: string;
  /** 这一行是关联工程的根（多工程树才有），不是普通目录。 */
  project?: boolean;
  branch?: "java-file" | "java-symbol";
  symbol?: { file: string; line: number; column: number };
}

/** 一棵树的根：单工程时就是工作区根，多工程时是每个关联工程的根。 */
export interface TreeRoot {
  path: string;
  label?: string;
}

export interface TreeSelection {
  path: string;
  isDir: boolean;
}

export type TreeNavAction =
  | { kind: "select"; path: string; isDir: boolean }
  | { kind: "toggle"; path: string }
  | { kind: "open"; path: string };

/**
 * 把已展开的目录按显示顺序摊平。键盘导航与 `aria-activedescendant` 都用它。
 *
 * 必须与 `FileTree` 的渲染口径一致：压缩中间包之后，`com` / `com/aier` 这些中间层
 * 不占行，摊平时也只保留链尾那一行，否则方向键会停在看不见的行上。
 *
 * `projectRows` = 多工程树：每棵根先占一行，展开后才是它的子项。单工程保持原样
 * （根目录本身不占行），否则所有现有行为都会多出一行「工作区根」。
 *
 * `hoist` = NC 结构视图：业务组件模块的 `src` 层被摊平，模块下直接列
 * `public/client/private/test/resources`（见 `lib/ncStructure`）。
 */
export function flattenTree(
  dirs: Record<string, TreeDirState>,
  expanded: Set<string>,
  root: string | TreeRoot[],
  opts: {
    filter?: (name: string, path: string, isDir: boolean, kind?: string) => boolean;
    compact?: boolean;
    projectRows?: boolean;
    /** 这一层的子目录要不要摊平 `src`（NC 结构视图）。 */
    hoist?: (dir: string) => boolean;
    packageRoots?: PackageRoots;
    packageIndexes?: PackageIndexes;
    members?: TreeMembers;
  } = {},
): FlatRow[] {
  const out: FlatRow[] = [];
  const filter = opts.filter;
  const compact = opts.compact !== false;
  const walk = (dir: string, parent: string | null) => {
    const st = dirs[dir];
    if (!st || st.status !== "ok") return;
    const kids = packageChildren(dir, st.items, {
      hoist: opts.hoist?.(dir) === true,
      dirs,
    }, opts.packageRoots, opts.packageIndexes);
    for (const { dir: from, item, label, kind } of kids) {
      const full = joinPath(from, item.name);
      if (filter && !filter(label ?? item.name, full, item.isDir, kind)) continue;
      if (item.isDir) {
        const chain = dirChain(compact && packageCompact(opts.packageRoots, full, opts.packageIndexes), full, label ?? item.name, dirs);
        out.push({
          path: chain.tail,
          isDir: true,
          parent,
          label: chain.label,
          realParent: from === dir ? undefined : from,
        });
        if (chainOpen(chain, expanded)) walk(chain.tail, chain.tail);
      } else {
        const memberRows = opts.members?.get(full)?.rows ?? [];
        const branch = opts.members && hasJavaMembers(full) ? "java-file" : undefined;
        out.push({ path: full, isDir: false, parent, realParent: from === dir ? undefined : from, ...(branch ? { branch } : {}) });
        const parents = new Set(memberRows.map(member => member.parent));
        for (const member of memberRows) {
          out.push({
            path: member.id, isDir: false, parent: member.parent, label: member.name,
            branch: parents.has(member.id) ? "java-symbol" : undefined,
            symbol: { file: full, line: member.line, column: member.column },
          });
        }
      }
    }
  };
  const roots = typeof root === "string" ? [{ path: root }] : root;
  for (const r of roots) {
    if (opts.projectRows) {
      if (filter && !filter(r.label ?? "", r.path, true, "project")) continue;
      out.push({ path: r.path, isDir: true, parent: null, label: r.label, project: true });
      if (expanded.has(r.path)) walk(r.path, r.path);
    } else {
      walk(r.path, null);
    }
  }
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
      if (flat[at]?.branch === "java-file") {
        if (!expanded.has(selected.path)) return { kind: "toggle", path: selected.path };
        return selectAt(flat.findIndex(r => r.parent === selected.path));
      }
      if (flat[at]?.branch === "java-symbol") return selectAt(flat.findIndex(r => r.parent === selected.path));
      if (!selected.isDir) return null;
      if (!expanded.has(selected.path)) return { kind: "toggle", path: selected.path };
      return selectAt(flat.findIndex((r) => r.parent === selected.path));
    case "ArrowLeft": {
      if (!selected) return null;
      if ((selected.isDir || flat[at]?.branch === "java-file") && expanded.has(selected.path)) {
        return { kind: "toggle", path: selected.path };
      }
      const row = flat[at];
      return row?.parent ? selectAt(flat.findIndex(r => r.path === row.parent)) : null;
    }
    case "Enter":
    case " ":
      if (!selected || at < 0) return null;
      return selected.isDir ? { kind: "toggle", path: selected.path } : { kind: "open", path: selected.path };
    default:
      return null;
  }
}
