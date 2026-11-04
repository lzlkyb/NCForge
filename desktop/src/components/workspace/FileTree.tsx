import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ContextMenu } from "./ContextMenu";
import { TreeFilterBar, TreeDeleteConfirm } from "./TreeChrome";
import { TreeRows, type TreeRowsCtx } from "./TreeRows";
import { TreeProjectRows } from "./TreeProjectRows";
import { useTreeDelete } from "./useTreeDelete";
import { useTreeEdit } from "./useTreeEdit";
import { useTreeLoad } from "./useTreeLoad";
import { useTreeHandlers } from "./useTreeHandlers";
import { useNcComponents } from "../../hooks/useNcComponents";
import { useTreeMenu } from "../../hooks/useTreeMenu";
import { useTreeLocate } from "../../hooks/useTreeLocate";
import {
  type NewEntryKind,
} from "../../lib/workspace";
import { flattenTree, treeKeyAction, treeRowId as rowId } from "../../lib/treeNav";
import { countBookmarks, useBookmarks } from "../../lib/bookmarks";
import { useCompactPackages, useNcStructure, useRevealOnOpen } from "../../lib/treeViewPrefs";
import { isUnderPath } from "../../lib/treeProjects";
import type { LinkedProject } from "../../lib/linkedProjects";

interface Props {
  root: string;
  /**
   * 关联工程（含当前工作区）。多于一个时树把各工程并排显示；不给或只有一个时
   * 保持原样（根目录本身不占行）。
   */
  projects?: LinkedProject[];
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
  /**
   * 编译某个路径所属的模块（右键菜单「编译模块 X」）。
   * 与标签栏那个不同：它不依赖活动标签，批量改完一个模块后不用先打开它的文件。
   */
  onCompileModule: (path: string) => void;
}

export interface FileTreeHandle {
  /** 在当前选中项下开始新建（没选中就用根目录）。 */
  startCreate: (kind: NewEntryKind) => void;
}

/**
 * 懒加载文件树：展开某个目录时才向后端请求这一层，不预读整棵树
 * （newar 约 7000 个源文件、几十个模块，整棵预读会卡首屏）。
 *
 * 三件事与 IDEA 对齐：
 * - **自动定位**：右边打开什么文件，左边就展开并滚到那一行（只对工作区内的真实文件；
 *   标题栏可关，显式的「在文件树中显示」不受开关影响）；
 * - **压缩中间包**：`com → aier → erp` 合成一行（`lib/treeCompact`，与键盘导航同源）；
 * - **NC 结构视图**：业务组件模块的 `src` 摊平，展开直接看到 `public/client/private/test`
 *   （`lib/ncStructure`，与键盘导航同源；默认关，见 `lib/treeViewPrefs`）。
 *
 * speed search：焦点在树上直接敲字筛选，Esc 清除。
 *
 * 展开态与已加载的目录存在 `lib/workspaceSession`：切页面会卸载本组件，
 * 状态要是留在 useState 里，从搜索页跳回来就得重新点开一遍。
 */
export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree(
  { root, projects, activePath, onOpen, onPin, onCreated, onRenamed, onDeleted, openPaths, onCompileModule },
  ref,
) {
  const [selected, setSelected] = useState<{ path: string; isDir: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const compact = useCompactPackages();
  const ncStructure = useNcStructure();
  const revealOnOpen = useRevealOnOpen();
  const multi = (projects?.length ?? 0) > 1;
  // 稳定引用：它进了 useTreeLoad.reveal 的依赖，每帧换新会让自动定位反复触发
  const rootRows = useMemo(
    () => (multi ? projects!.filter((p) => p.root).map((p) => ({ path: p.root!, label: p.name })) : []),
    [multi, projects],
  );
  const roots = useMemo(
    () => (multi ? rootRows.map((r) => r.path) : [root]),
    [multi, rootRows, root],
  );
  const bookmarks = useBookmarks(root);
  // manifest.xml 只用来给模块行打「业务组件」徽章、并决定 NC 结构视图摊不摊 `src`，
  // 不参与树的取数（见 lib/ncManifest / hooks/useNcComponents）
  const { bcNames, isBcModule, hoist } = useNcComponents(roots, ncStructure);
  const { dirs, expanded, marks, load, expand, toggle, toggleRow, depthOf, reveal } = useTreeLoad(
    root,
    compact,
    roots,
    hoist,
  );
  // 行只拿一个数字（条数），值没变时行组件的 memo 仍然命中
  const bookmarkCounts = useMemo(() => countBookmarks(bookmarks), [bookmarks]);
  const isEditable = useCallback(
    (path: string) => isUnderPath(path, root),
    [root],
  );
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

  // ---- 定位 ----

  // 清筛选的引用要稳定：它进了 locate 的依赖，每帧换新会让自动定位反复触发
  const clearFilter = useCallback(() => setFilter(""), []);
  useTreeLocate(reveal, activePath, revealOnOpen, clearFilter);

  // ---- 菜单 ----

  const { menu, menuItems, openMenu, closeMenu } = useTreeMenu({
    root,
    isEditable,
    onOpen,
    onCompileModule,
    beginCreate,
    beginRename,
    askDelete,
    load,
    setSelected,
  });

  useImperativeHandle(ref, () => ({
    startCreate: (kind) => {
      // 选中的是关联工程的目录时，新建会落到当前工作区根：后端只允许写当前工程
      const target =
        selected && isEditable(selected.path) ? selected : { path: root, isDir: true };
      beginCreate(target, kind);
    },
  }));

  // ---- 键盘与筛选 ----

  const filterFn = useCallback(
    (name: string) => !filter || name.toLowerCase().includes(filter.toLowerCase()),
    [filter],
  );
  const flat = useMemo(
    () =>
      flattenTree(dirs, expanded, multi ? rootRows : root, {
        filter: filterFn,
        compact,
        projectRows: multi,
        hoist,
      }),
    [dirs, expanded, root, rootRows, multi, filterFn, compact, hoist],
  );

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
        // 工程根行不参与压缩链：点一下只展开这一层
        if (row?.project) toggle(act.path);
        // NC 结构视图摊平后的行真身在 `bill/src` 下，问压缩链要用真实父目录
        else toggleRow(act.path, row?.realParent ?? row?.parent ?? root);
      } else onOpen(act.path);
      return;
    }
    if (!selected) return;
    // 关联工程只读：F2 / Del 在后端必被拒，这里直接不接
    if (!isEditable(selected.path)) return;
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

  const handlers = useTreeHandlers({
    toggleRow,
    toggle,
    onOpen,
    onPin,
    openMenu,
    commitEdit,
    cancelEdit,
    setSelected,
    isEditable,
  });

  const ctx: TreeRowsCtx = {
    dirs,
    expanded,
    activePath,
    selectedPath: selected?.path ?? null,
    marks,
    bookmarkCounts,
    filter: filterFn,
    compact,
    hoist,
    isBcModule,
    bcNames,
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
        {multi ? (
          <TreeProjectRows projects={projects!} root={root} ctx={ctx} />
        ) : (
          <TreeRows dir={root} depth={0} ctx={ctx} />
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={closeMenu} />
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
