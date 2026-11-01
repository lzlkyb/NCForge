import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { toast } from "../ui/toast";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { TreeFilterBar, TreeDeleteConfirm } from "./TreeChrome";
import { TreeRows, type TreeRowsCtx } from "./TreeRows";
import { buildTreeMenu } from "./treeMenu";
import { useTreeDelete } from "./useTreeDelete";
import { useTreeEdit } from "./useTreeEdit";
import { useTreeLoad } from "./useTreeLoad";
import { dirName, type NewEntryKind } from "../../lib/workspace";
import { flattenTree, treeKeyAction, treeRowId as rowId } from "../../lib/treeNav";
import { chainFor, chainOpen } from "../../lib/treeCompact";
import { countBookmarks, useBookmarks } from "../../lib/bookmarks";

interface Props {
  root: string;
  activePath: string | null;
  onOpen: (path: string) => void;
  /** 双击文件：固定预览标签。 */
  onPin?: (path: string) => void;
  /** 新建文件成功，调用方负责打开它。 */
  onCreated: (path: string) => void;
  /** 重命名成功，调用方负责把已打开的标签挪到新路径。 */
  onRenamed: (oldPath: string, newPath: string) => void;
  /** 删除完成，传入被删的路径（目录只给目录本身，子项由调用方按前缀判断）。 */
  onDeleted: (paths: string[]) => void;
  /** 当前已打开的标签，删除确认里要提示会影响几个。 */
  openPaths: string[];
}

export interface FileTreeHandle {
  /** 在当前选中项下开始新建（没选中就用根目录）。 */
  startCreate: (kind: NewEntryKind) => void;
}

/** 自动定位的防抖：连着点标签时不要每个都展开一遍。 */
const REVEAL_DELAY_MS = 120;

/**
 * 懒加载文件树：展开某个目录时才向后端请求这一层，不预读整棵树
 * （newar 约 7000 个源文件、几十个模块，整棵预读会卡首屏）。
 *
 * 三件事与 IDEA 对齐：
 * - **自动定位**：右边打开什么文件，左边就展开并滚到那一行（只对工作区内的真实文件）；
 * - **压缩中间包**：`com → aier → erp` 合成一行（`lib/treeCompact`，与键盘导航同源）；
 * - **speed search**：焦点在树上直接敲字筛选，Esc 清除。
 *
 * 展开态与已加载的目录存在 `lib/workspaceSession`：切页面会卸载本组件，
 * 状态要是留在 useState 里，从搜索页跳回来就得重新点开一遍。
 */
export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree(
  { root, activePath, onOpen, onPin, onCreated, onRenamed, onDeleted, openPaths },
  ref,
) {
  const [selected, setSelected] = useState<{ path: string; isDir: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(
    null,
  );
  const [filter, setFilter] = useState("");
  const { dirs, expanded, marks, load, expand, depthOf, reveal, setExpandedPaths } = useTreeLoad(root);
  const bookmarks = useBookmarks(root);
  // 行只拿一个数字（条数），值没变时行组件的 memo 仍然命中
  const bookmarkCounts = useMemo(() => countBookmarks(bookmarks), [bookmarks]);
  const { editing, editError, busy, beginCreate, beginRename, cancelEdit, commitEdit } = useTreeEdit({
    root,
    dirs,
    load,
    expand,
    depthOf,
    onCreated,
    onRenamed,
    setSelected,
  });
  const { pendingDelete, askDelete, confirmDelete, cancelDelete } = useTreeDelete({
    root,
    load,
    onDeleted,
    openPaths,
    setSelected,
  });

  // ---- 自动定位 ----

  /** 行是异步渲染出来的：两帧之后再滚，避免"滚到了还没出现的行"。 */
  const scrollToRow = (path: string) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document.getElementById(rowId(path))?.scrollIntoView({ block: "nearest" }),
      ),
    );
  };

  const locate = useCallback(
    async (path: string | null) => {
      if (!path) return;
      // 被筛掉的行定位过去等于"看不见的成功"，先清筛选
      setFilter("");
      if (await reveal(path)) scrollToRow(path);
    },
    [reveal],
  );

  useEffect(() => {
    if (!activePath) return;
    const t = window.setTimeout(() => void locate(activePath), REVEAL_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [activePath, locate]);

  // 「在文件树中显示」命令（标签右键 / 命令面板）走同一份定位逻辑
  useEffect(() => {
    const h = (e: Event) => void locate((e as CustomEvent<string>).detail);
    window.addEventListener("ncforge-reveal-in-tree", h);
    return () => window.removeEventListener("ncforge-reveal-in-tree", h);
  }, [locate]);

  // ---- 菜单 ----

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast("已复制路径", "success");
    } catch {
      toast("复制失败：系统剪贴板不可用", "error");
    }
  };

  const menuItems = (m: { path: string; isDir: boolean }): ContextMenuItem[] =>
    buildTreeMenu({
      target: m,
      root,
      onOpen,
      onBeginCreate: beginCreate,
      onBeginRename: beginRename,
      onDelete: (t) => void askDelete(t),
      onCopyPath: (p) => void copyPath(p),
      onRefresh: (t) => void load(t.isDir ? t.path : dirName(t.path)),
    });

  const openMenu = (e: ReactMouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected({ path, isDir });
    setMenu({ x: e.clientX, y: e.clientY, path, isDir });
  };

  useImperativeHandle(ref, () => ({
    startCreate: (kind) => beginCreate(selected ?? { path: root, isDir: true }, kind),
  }));

  // ---- 键盘与筛选 ----

  const filterFn = useCallback(
    (name: string) => !filter || name.toLowerCase().includes(filter.toLowerCase()),
    [filter],
  );
  const flat = useMemo(() => flattenTree(dirs, expanded, root, { filter: filterFn }), [dirs, expanded, root, filterFn]);

  /** 展开 / 收起一条压缩链：收起时要把链上每一层都去掉，否则下一帧又压不回去。 */
  const toggleChain = (tail: string, parent: string | null) => {
    const chain = chainFor(tail, parent, dirs);
    const open = chainOpen(chain, expanded);
    setExpandedPaths(chain.nodes, !open);
    if (!open) void load(chain.tail);
  };

  /**
   * 方向键导航的语义在 `lib/treeNav`（纯函数，可单测）；这里只把动作落到状态上。
   * 焦点一直留在容器上（行是 `tabIndex=-1`），靠 `aria-activedescendant` 播报当前行。
   *
   * 可打印字符进来就是 speed search 的开始（IDEA 的行为），不会误伤导航键。
   */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (editing) return;
    if (e.key === "Escape" && filter) {
      e.preventDefault();
      setFilter("");
      return;
    }
    if (e.key === "Backspace" && filter) {
      e.preventDefault();
      setFilter((f) => f.slice(0, -1));
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setFilter((f) => f + e.key);
      return;
    }
    const act = treeKeyAction(e.key, flat, selected, expanded);
    if (act) {
      e.preventDefault();
      if (act.kind === "select") setSelected({ path: act.path, isDir: act.isDir });
      else if (act.kind === "toggle") {
        const row = flat.find((r) => r.path === act.path);
        toggleChain(act.path, row?.parent ?? root);
      } else onOpen(act.path);
      return;
    }
    if (!selected) return;
    if (e.key === "F2") {
      e.preventDefault();
      beginRename(selected);
    } else if (e.key === "Delete") {
      e.preventDefault();
      void askDelete(selected);
    } else if (e.key === "Escape") {
      setSelected(null);
    }
  };

  // ---- 渲染 ----

  /**
   * 行组件是 `memo` 的，所以传给它们的回调必须**身份稳定**。
   *
   * 直接传 `() => …` 等于每次渲染都换一批 prop，`memo` 一次也命中不了；而在
   * `useCallback` 上挂全量依赖又会随 `dirs/expanded` 每变一次就换一次身份。
   * 做法是 ref 里存最新实现、外层给一次性外壳——行组件拿到的是稳定引用，调用的
   * 永远是当前闭包。
   */
  const latest = useRef({ toggleChain, onOpen, onPin, openMenu, commitEdit, cancelEdit, setSelected });
  latest.current = { toggleChain, onOpen, onPin, openMenu, commitEdit, cancelEdit, setSelected };
  const handlers = useMemo(
    () => ({
      onToggle: (tail: string, parent: string) => latest.current.toggleChain(tail, parent),
      onActivate: (path: string) => {
        latest.current.setSelected({ path, isDir: false });
        latest.current.onOpen(path);
      },
      onPin: (path: string) => latest.current.onPin?.(path),
      onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) =>
        latest.current.openMenu(e, path, isDir),
      onCommitEdit: (v: string) => void latest.current.commitEdit(v),
      onCancelEdit: () => latest.current.cancelEdit(),
    }),
    [],
  );

  const ctx: TreeRowsCtx = {
    dirs,
    expanded,
    activePath,
    selectedPath: selected?.path ?? null,
    marks,
    bookmarkCounts,
    filter: filterFn,
    editing,
    editError,
    busy,
    ...handlers,
  };

  return (
    <>
      <div
        className="wb-tree-list"
        role="tree"
        aria-label="文件树"
        tabIndex={0}
        aria-activedescendant={selected ? rowId(selected.path) : undefined}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          // 空白处右键 = 对工作区根操作（新建到根下）
          if (e.target === e.currentTarget) openMenu(e, root, true);
        }}
      >
        {filter && <TreeFilterBar filter={filter} count={flat.length} onClear={() => setFilter("")} />}
        <TreeRows dir={root} depth={0} ctx={ctx} />
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />
      )}

      <TreeDeleteConfirm
        pending={pendingDelete}
        onCancel={cancelDelete}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
});

/**
 * 删除确认的正文（文件数 / 打开中的标签 / 未保存的修改 / 引用提示）在 `lib/treeDeleteText`：
 * 这里是接线而不是措辞，况且那段判断值得单测。
 */
