import { useCallback, useEffect } from "react";
import { encodingMarks, joinPath, listDir, type DirItem } from "../../lib/workspace";
import { getSession, setSession, setTree, useWorkspaceSession } from "../../lib/workspaceSession";

/**
 * 文件树的数据层：按需加载某一层、维护展开态与编码标记。
 *
 * 状态存在 `lib/workspaceSession` 而不是 useState：切页面会卸载组件，
 * 留在本地状态里的话，从搜索页跳回来就得重新点开一遍。
 *
 * 为什么列目录与编码标记分开跑：列表先出来，标记晚一拍到，展开目录不用等它。
 */
export function useTreeLoad(root: string) {
  const { tree } = useWorkspaceSession();
  const { dirs, expanded, marks } = tree;

  /**
   * 问后端这一层的 `.java` 里，哪些是「磁盘 UTF-8、Eclipse 却按 GBK 读」。
   *
   * 失败就当没有标记——这是提示，不该因为它让目录打不开。
   */
  const markEncodings = useCallback(async (dir: string, items: DirItem[]) => {
    const files = items
      .filter((i) => !i.isDir && i.name.toLowerCase().endsWith(".java"))
      .map((i) => joinPath(dir, i.name));
    if (files.length === 0) return;
    try {
      const found = await encodingMarks(files);
      setTree((t) => {
        const next = { ...t.marks };
        // 这一层刚重扫过：先清旧标记，文件改回 GBK 后徽标才会消失
        for (const p of files) delete next[p];
        for (const m of found) next[m.path] = m;
        return { ...t, marks: next };
      });
    } catch {
      // 忽略：标记是附加信息
    }
  }, []);

  const load = useCallback(
    async (path: string) => {
      // 已经有内容就别退回「加载中…」，刷新时列表原地替换，不闪
      setTree((t) =>
        t.dirs[path]?.status === "ok"
          ? t
          : { ...t, dirs: { ...t.dirs, [path]: { status: "loading" } } },
      );
      try {
        const items = await listDir(path);
        setTree((t) => ({ ...t, dirs: { ...t.dirs, [path]: { status: "ok", items } } }));
        void markEncodings(path, items);
      } catch (e) {
        setTree((t) => ({
          ...t,
          dirs: { ...t.dirs, [path]: { status: "error", message: String(e) } },
        }));
      }
    },
    [markEncodings],
  );

  // 工作区根变化（首次打开 / 更换目录）时重置整棵树，只展开根。
  // 根没变（= 只是切页面回来）就直接复用缓存，不再打一次 IPC。
  //
  // 只有 ok / loading 才算「可复用」：上次加载失败（比如盘还没挂上）也算有缓存的话，
  // 切页回来永远不会重试，用户只能一直看着那行错误。
  useEffect(() => {
    const cached = getSession().tree;
    const dir = cached.dirs[root];
    if (cached.root === root && (dir?.status === "ok" || dir?.status === "loading")) return;
    setSession({ tree: { root, expanded: new Set([root]), dirs: {}, marks: {} } });
    void load(root);
  }, [root, load]);

  const expand = (path: string) =>
    setTree((t) => (t.expanded.has(path) ? t : { ...t, expanded: new Set(t.expanded).add(path) }));

  /** 路径在树里的层级（根为 0）。只用来算缩进。 */
  const depthOf = (path: string) => {
    if (!path || path === root) return 0;
    const rel = path.slice(root.length).replace(/^[\\/]/, "");
    return rel.split(/[\\/]/).filter(Boolean).length;
  };

  const toggle = (path: string) => {
    const isOpen = expanded.has(path);
    setTree((t) => {
      const next = new Set(t.expanded);
      if (isOpen) next.delete(path);
      else next.add(path);
      return { ...t, expanded: next };
    });
    // 展开且还没加载过（或上次加载失败）才请求
    if (!isOpen && dirs[path]?.status !== "ok") void load(path);
  };

  return { dirs, expanded, marks, load, expand, toggle, depthOf };
}
