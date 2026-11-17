import { useCallback } from "react";
import { filePathKey, joinPath } from "../../lib/workspace";
import { isUnderPath } from "../../lib/treeProjects";
import { getSession } from "../../lib/workspaceSession";
import { packageLocation, sourceForPath, type PackageIndex, type PackageRoots } from "../../lib/packageTree";
import { workspaceEpoch } from "../../lib/workspaceEpoch";

/** 定位到某个文件时最多展开多少层：防止异常路径（工作区外的长路径）把界面锁死。 */
const REVEAL_MAX_DEPTH = 40;

export type TreeFilterMode = "problems" | "changes";

interface RevealDeps {
  root: string;
  epoch: number;
  projectRoots?: string[];
  /** 不传 = 包视图没开，整条「包目录」分支跳过。 */
  packageRoots: PackageRoots | undefined;
  /** 包目录索引（懒建，失败返回 null）。 */
  ensure: (source: string) => Promise<PackageIndex | null>;
  load: (dir: string) => Promise<void>;
  setExpandedPaths: (paths: string[], open: boolean, mode: TreeFilterMode | null) => void;
  /** 当前筛选视图模式；`explicit` 定位会把它清掉。 */
  filterMode: { current: TreeFilterMode | null };
  /**
   * 清掉筛选视图。**必须传 `setFilteredTree` 本身**：内联箭头函数每次渲染都是新引用，
   * 会把下面这个 `useCallback` 的恒定性打掉，进而让 `useTreeLocate` 的 effect 反复重跑
   * （定位到一半被下一次定位打断）。
   */
  setFilteredTree: (value: null) => void;
}

/**
 * 「把某个路径展开到可见」——搜索、跳转、外部单实例请求都走这条路。
 *
 * 与 `toggle` / `expand` 分开的原因：那两个只动 `expanded` 集合，假定用户是
 * 顺着树往下点的；这里要**从工程根一层层读盘**，还得把压缩中间包、包目录、
 * 多工程根这几种结构抹平。合在一起会让 `useTreeLoad` 里两种节奏的代码缠在一处。
 *
 * 返回**树上真实存在的路径**（大小写以磁盘为准），拿不到就返回 `null`——
 * 调用方据此决定是「跳不过去」还是「跳到一个错的路径」。
 */
export function useTreeReveal(deps: RevealDeps) {
  const { root, epoch, projectRoots, packageRoots, ensure, load, setExpandedPaths, filterMode, setFilteredTree } = deps;

  return useCallback(
    async (path: string, explicit: boolean, signal: AbortSignal): Promise<string | null> => {
      const current = () => !signal.aborted && workspaceEpoch() === epoch;
      if (!current()) return null;
      const roots = projectRoots && projectRoots.length > 0 ? projectRoots : [root];
      // 根互相嵌套时取最长的那个：路径归属只有一位真答案
      const owner = roots
        .filter((r) => isUnderPath(path, r))
        .sort((a, b) => b.length - a.length)[0];
      if (!owner) return null;
      const parts = path.slice(owner.length).replace(/^[\\/]/, "").split(/[\\/]/).filter(Boolean);
      if (!parts.length || parts.length > REVEAL_MAX_DEPTH) return null;
      // 多工程树里工程根本身是一行，必须先展开它；单工程时 expanded 里本来就有它
      const mode = explicit ? null : filterMode.current;
      if (explicit && filterMode.current) setFilteredTree(null);
      const openDirectory = async (dir: string) => {
        setExpandedPaths([dir], true, mode);
        if (getSession().tree.dirs[dir]?.status !== "ok") await load(dir);
        const state = getSession().tree.dirs[dir];
        return current() && state?.status === "ok" ? state.items : null;
      };
      let items = await openDirectory(owner);
      if (!items) return null;
      const source = sourceForPath(packageRoots, path);
      const index = source ? await ensure(source) : null;
      if (!current()) return null;
      let cur = owner;
      if (source && index) {
        const packageDir = packageLocation(source, index, path);
        items = await openDirectory(source);
        if (!items) return null;
        cur = packageDir ?? source;
        if (packageDir) items = await openDirectory(packageDir);
      }
      const from = cur === owner ? 0 : cur.slice(owner.length).split(/[\\/]/).filter(Boolean).length;
      for (let i = from; i < parts.length; i += 1) {
        const final = i === parts.length - 1;
        const key = filePathKey(parts[i]);
        const entry = items?.find(item => (final || item.isDir) && filePathKey(item.name) === key);
        if (!entry) return null;
        cur = joinPath(cur, entry.name);
        if (final) return cur;
        items = await openDirectory(cur);
      }
      return null;
    },
    [load, projectRoots, root, epoch, packageRoots, ensure, setExpandedPaths, filterMode, setFilteredTree],
  );
}
