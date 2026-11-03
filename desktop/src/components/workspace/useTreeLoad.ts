import { useCallback, useEffect } from "react";
import { baseName, encodingMarks, joinPath, listDir, type DirItem } from "../../lib/workspace";
import { chainFor, chainOpen, collapseChain } from "../../lib/treeCompact";
import { listen } from "../../lib/tauri";
import { pathKey } from "../../lib/treeSvn";
import { isUnderPath } from "../../lib/treeProjects";
import { getSession, setSession, setTree, useWorkspaceSelector } from "../../lib/workspaceSession";

/** 定位到某个文件时最多展开多少层：防止异常路径（工作区外的长路径）把界面锁死。 */
const REVEAL_MAX_DEPTH = 40;

/**
 * 文件树的数据层：按需加载某一层、维护展开态与编码标记。
 *
 * 状态存在 `lib/workspaceSession` 而不是 useState：切页面会卸载组件，
 * 留在本地状态里的话，从搜索页跳回来就得重新点开一遍。
 *
 * 为什么列目录与编码标记分开跑：列表先出来，标记晚一拍到，展开目录不用等它。
 *
 * `projectRoots` 是多工程树的全部根（不含时只有当前工作区）。展开 / 定位只看路径
 * 归属，不关心它是不是当前工程——浏览别的工程是允许的，写操作才受限制。
 */
export function useTreeLoad(root: string, compact: boolean, projectRoots?: string[]) {
  // 只订阅树：整会话订阅下，每次 dirty 翻转 / 编译状态变化都会把整棵树重渲染一遍
  const tree = useWorkspaceSelector((s) => s.tree);
  const { dirs, expanded, marks } = tree;
  const roots = projectRoots && projectRoots.length > 0 ? projectRoots : [root];

  /**
   * 问后端这一层的 `.java` 里，哪些是「磁盘 UTF-8、Eclipse 却按 GBK 读」。
   *
   * 只问当前工作区：别的工程不可写，`fs_encoding_marks` 的白名单仍只认当前工程，
   * 问了也只会拿到一串拒绝错误。失败就当没有标记——这是提示，不该让目录打不开。
   */
  const markEncodings = useCallback(
    async (dir: string, items: DirItem[]) => {
      if (!isUnderPath(dir, root)) return;
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
    },
    [root],
  );

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

  /**
   * 外部改动（SVN 更新、Eclipse 保存、脚本生成文件）：后端把改动合并成一批目录报上来。
   * 只刷新已经读过的目录——没展开过的目录没有缓存，下次展开时本来就会读最新的。
   *
   * `rescan` = 平台丢了监听范围（如 inotify 上限、根目录被替换），这时后端不知道
   * 具体改了哪些目录，只能把读过的一层全部重读。层数受展开深度限制，代价可控。
   */
  const refreshDirs = useCallback(
    (changed: string[], rescan: boolean) => {
      if (!rescan && changed.length === 0) return;
      const wanted = rescan ? null : new Set(changed.map(pathKey));
      for (const [dir, entry] of Object.entries(getSession().tree.dirs)) {
        // 正在读的那一层，结果回来时本身就是新的，不叠加一次
        if (entry.status === "loading") continue;
        if (!wanted || wanted.has(pathKey(dir))) void load(dir);
      }
    },
    [load],
  );

  // 订阅后端的文件监听。注册是异步的，组件可能在它回来前就卸载：
  // 用 disposed 兜住，否则监听会挂在已卸载的组件上。
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listen<{ dirs?: string[]; rescan?: boolean }>("fs-changed", (p) =>
      refreshDirs(p?.dirs ?? [], p?.rescan === true),
    )
      .then((u) => {
        if (disposed) u();
        else off = u;
      })
      .catch(() => {
        // 注册失败（如纯浏览器调试）：退化为手动刷新，不影响树本身
      });
    return () => {
      disposed = true;
      off?.();
    };
  }, [refreshDirs]);

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

  // 「压缩中间包」要往下多看几层：某个目录展开后，若它一路只有一个子目录，
  // 把链条末端也预读出来，行标题才能稳定显示成 `com.aier.erp`。
  // 不预读的话，用户每展开一次标题就变一次（com → com.aier → …），很难受。
  useEffect(() => {
    if (!compact) return;
    for (const dir of expanded) {
      const chain = collapseChain(dir, baseName(dir), dirs);
      if (chain.tail !== dir && !dirs[chain.tail]) void load(chain.tail);
    }
  }, [compact, expanded, dirs, load]);

  const expand = (path: string) =>
    setTree((t) => (t.expanded.has(path) ? t : { ...t, expanded: new Set(t.expanded).add(path) }));

  /** 一次性改多层展开态（压缩链的展开 / 收起要动整条链）。 */
  const setExpandedPaths = (paths: string[], open: boolean) =>
    setTree((t) => {
      const next = new Set(t.expanded);
      for (const p of paths) {
        if (open) next.add(p);
        else next.delete(p);
      }
      return { ...t, expanded: next };
    });

  /**
   * 展开 / 收起一行。压缩模式下要动整条链：只删链尾的话，上一层在 `expanded` 里还开着，
   * 下一帧又被 `chainOpen` 判成展开，看起来像「点了没反应」。
   */
  const toggleRow = (path: string, parent: string | null) => {
    const chain = compact
      ? chainFor(path, parent, dirs)
      : { nodes: [path], label: path, tail: path };
    const open = chainOpen(chain, expanded);
    setExpandedPaths(chain.nodes, !open);
    if (!open) void load(chain.tail);
  };

  /** 路径在树里的层级（根为 0）。只用来算缩进。 */
  const depthOf = (path: string) => {
    if (!path || path === root) return 0;
    const rel = path.slice(root.length).replace(/^[\\/]/, "");
    return rel.split(/[\\/]/).filter(Boolean).length;
  };

  const toggle = (path: string) => {
    const isOpen = expanded.has(path);
    setExpandedPaths([path], !isOpen);
    // 展开且还没加载过（或上次加载失败）才请求
    if (!isOpen && dirs[path]?.status !== "ok") void load(path);
  };

  /**
   * 定位到某个文件：逐层展开祖先并加载，返回是否成功。
   *
   * 祖先链直接从路径字符串算出来，不向后端问——`com/aier/erp/x.java` 的父目录就是
   * 路径前缀。可定位的路径 = 任一关联工程内的路径：自动定位可能停在别的工程的文件上
   * （比如刚跨工程打开），这时要先把那个工程的根展开。
   */
  const reveal = useCallback(
    async (path: string): Promise<boolean> => {
      if (!path) return false;
      // 根互相嵌套时取最长的那个：路径归属只有一位真答案
      const owner = roots
        .filter((r) => isUnderPath(path, r))
        .sort((a, b) => b.length - a.length)[0];
      if (!owner) return false;
      const parts = path.slice(owner.length).replace(/^[\\/]/, "").split(/[\\/]/).filter(Boolean);
      if (parts.length > REVEAL_MAX_DEPTH) return false;
      // 多工程树里工程根本身是一行，必须先展开它；单工程时 expanded 里本来就有它
      setTree((t) =>
        t.expanded.has(owner) ? t : { ...t, expanded: new Set(t.expanded).add(owner) },
      );
      let cur = owner;
      // 注意祖先循环从第一段开始：文件所在目录也要展开，不能只展开父目录本身
      if (getSession().tree.dirs[owner]?.status !== "ok") await load(owner);
      for (let i = 0; i < parts.length - 1; i += 1) {
        cur = joinPath(cur, parts[i]);
        setTree((t) => (t.expanded.has(cur) ? t : { ...t, expanded: new Set(t.expanded).add(cur) }));
        if (getSession().tree.dirs[cur]?.status !== "ok") await load(cur);
      }
      return true;
    },
    [load, roots],
  );

  return { dirs, expanded, marks, load, expand, toggle, toggleRow, depthOf, reveal, setExpandedPaths };
}
