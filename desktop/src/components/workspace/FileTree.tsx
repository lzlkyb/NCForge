import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  lazy,
  Suspense,
} from "react";
import { ContextMenu } from "./ContextMenu";
import { TreeHeader } from "./TreeHeader";
import { TreeDeleteConfirm, TreeViewFilters } from "./TreeChrome";
import { TreeRows, type TreeRowsCtx } from "./TreeRows";
import { TreeSvnContext } from "./TreeSvnContext";
import { PackageDependencies } from "./PackageDependencies";
import { TreeProjectRows } from "./TreeProjectRows";
import { TreeActivePath } from "./TreeActivePath";
import { useTreeViewFilter } from "./useTreeViewFilter";
import { TreeQuickFilter } from "./TreeQuickFilter";
import { useTreeFilterState } from "../../lib/treeFilter";
import { useTreeDelete } from "./useTreeDelete";
import { useTreeEdit } from "./useTreeEdit";
import { useTreeMembers } from "../../hooks/useTreeMembers";
import { useTreeLoad } from "./useTreeLoad";
import { useTreeHandlers } from "./useTreeHandlers";
import { useTreeKeyboard } from "./useTreeKeyboard";
import { packageCompact, packageDepthOffset } from "../../lib/packageTree";
import { useNcComponents } from "../../hooks/useNcComponents";
import { useTreeMenu } from "../../hooks/useTreeMenu";
import { useProblemMarks, useProblemTreeFilter } from "../../hooks/useProblemMarks";
import { useTreeLocate } from "../../hooks/useTreeLocate";
import { registerCommands } from "../../lib/commandRegistry";
import { useViewActive } from "../../lib/viewActivity";
import type { NewEntryKind } from "../../lib/workspace";
import { useTreeNewJava } from "../../hooks/useTreeNewJava";
import { flattenTree, treeRowId as rowId } from "../../lib/treeNav";
import { countBookmarks, useBookmarks } from "../../lib/bookmarks";
import { useCompactPackages, useNcStructure, usePackageView, useRevealOnOpen, useSvnAuthor } from "../../lib/treeViewPrefs";
import { isUnderPath } from "../../lib/treeProjects";
import type { LinkedProject } from "../../lib/linkedProjects";

const TreeSvnHistory = lazy(() => import("./TreeSvnHistory"));

interface Props {
  root: string;
  /**
   * 关联工程（含当前工作区）。多于一个时树把各工程并排显示；不给或只有一个时
   * 保持原样（根目录本身不占行）。
   */
  projects?: LinkedProject[];
  activePath: string | null;
  onOpen: (path: string, pos?: { line: number; column: number }) => void;
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
  /** 编译某路径所属的模块（右键「编译模块 X」）；不依赖活动标签。 */
  onCompileModule: (path: string) => void;
  /** 清理模块产物 / 清理并重编（确认框在调用方）。 */
  onCleanModule?: (path: string, module: string) => void;
  onRebuildModule?: (path: string, module: string) => void;
}

/**
 * 目录和 Java 成员按展开加载，避免首次打开大工程时预读全部源码。
 * 文件夹展开态和缓存放在 workspaceSession，切换侧栏后仍可复用。
 */
export function FileTree({ root, projects, activePath, onOpen, onPin, onCreated, onRenamed, onDeleted, openPaths, onCompileModule, onCleanModule, onRebuildModule }: Props) {
  const viewActive = useViewActive();
  const [selected, setSelected] = useState<{ path: string; isDir: boolean } | null>(null);
  const [filter, setFilter, filterOpen, closeFilter] = useTreeFilterState(root);
  const problemMarks = useProblemMarks();
  const compact = useCompactPackages();
  const ncStructure = useNcStructure();
  const packageView = usePackageView();
  const { commitScope } = useContext(TreeSvnContext);
  const svnAuthor = useSvnAuthor();
  const showCommitAuthors = packageView && svnAuthor && !!commitScope;
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
  const { bcNames, isBcModule, hoist } = useNcComponents(roots, ncStructure && !packageView);
  const { dirs, expanded, marks, mode, setMode, load, expand, toggle, toggleRow, depthOf, reveal,
    packageRoots, packageIndexes, invalidatePackages, canCollapse, collapseBranches } = useTreeLoad(
    root,
    compact,
    roots,
    hoist, packageView, activePath,
  );
  const toggleVisibleRow = (path: string, parent: string | null) => {
    if (packageView && packageIndexes.get(path) === null && !expanded.has(path)) void invalidatePackages([path], false, false);
    if (packageCompact(packageRoots, path, packageIndexes)) toggleRow(path, parent);
    else toggle(path);
  };
  const { members, toggle: toggleMembers, closeAll: closeMembers } = useTreeMembers(packageView, dirs);
  const toggleFileMembers = (path: string) => {
    setSelected({ path, isDir: false });
    toggleMembers(path);
  };
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
    depthOf: path => depthOf(path) + packageDepthOffset(packageRoots, path, packageIndexes),
    onCreated,
    onRenamed: (from, to) => { if (packageView) invalidatePackages([from, to]); onRenamed(from, to); },
    onEntryCreated: path => { if (packageView) invalidatePackages([path]); },
    setSelected,
  });
  const { pendingDelete, askDelete, confirmDelete, cancelDelete } = useTreeDelete({
    root,
    load,
    onDeleted: paths => { if (packageView) invalidatePackages(paths); onDeleted(paths); },
    openPaths,
    setSelected,
  });
  // 关联工程只读，选中关联工程时从当前工作区根新建。
  const startCreate = (kind: NewEntryKind) =>
    beginCreate(selected && isEditable(selected.path) ? selected : { path: root, isDir: true }, kind);

  // 清筛选的引用要稳定：它进了 locate 的依赖，每帧换新会让自动定位反复触发
  const clearFilter = useCallback(() => setFilter(""), [setFilter]);
  const pauseLocate = useTreeLocate(reveal, activePath, revealOnOpen, clearFilter);

  const { openNewJava, newJavaDialog } = useTreeNewJava({
    root, load, expand, setSelected, onCreated,
    onEntryCreated: path => { if (packageView) invalidatePackages([path]); },
  });
  const { menu, menuItems, openMenu, closeMenu, history, closeHistory } = useTreeMenu({
    root,
    marks: problemMarks.paths,
    isEditable,
    onOpen,
    onCompileModule,
    onCleanModule,
    onRebuildModule,
    beginCreate,
    onNewJavaType: openNewJava,
    beginRename,
    askDelete,
    load,
    setSelected,
  });

  // ---- 键盘与筛选 ----

  const textAndProblemFilter = useProblemTreeFilter(filter, mode === "problems", problemMarks);
  const { filterFn, treeList, toggleMode, scrollToTop, changeCount } = useTreeViewFilter(mode, setMode, textAndProblemFilter);
  const flat = useMemo(
    () =>
      flattenTree(dirs, expanded, multi ? rootRows : root, {
        filter: filterFn,
        compact,
        projectRows: multi || packageView,
        hoist, packageRoots, packageIndexes, members: packageView ? members : undefined,
      }),
    [dirs, expanded, root, rootRows, multi, filterFn, compact, hoist, packageRoots, packageIndexes, packageView, members],
  );
  const collapseEnabled = !editing && (canCollapse || members.size > 0);
  const collapseAll = useCallback(() => {
    if (!collapseEnabled) return;
    pauseLocate();
    collapseBranches();
    closeMembers();
    setSelected(selected => {
      if (!selected) return null;
      let index = flat.findIndex(row => row.path === selected.path);
      // 展平顺序中，选中项上方第一个顶层行就是折叠后仍可见的祖先。
      while (index >= 0 && flat[index].parent !== null) index--;
      const ancestor = flat[index];
      return ancestor ? { path: ancestor.path, isDir: ancestor.isDir } : null;
    });
    scrollToTop();
  }, [collapseEnabled, pauseLocate, collapseBranches, closeMembers, flat, scrollToTop]);
  useEffect(() => registerCommands([{
    id: "view.collapseTree", title: "全部折叠资源树", run: collapseAll, enabled: () => viewActive && collapseEnabled,
  }]), [viewActive, collapseEnabled, collapseAll]);

  // 焦点留在容器，方向键按视觉树移动。规则与经验见 useTreeKeyboard
  // （编辑态只让 Esc 走、移动后滚到可见、导航可被筛选框复用）。
  const memberPaths = useMemo(() => new Set(members.keys()), [members]);
  const keys = useTreeKeyboard({
    flat, selected, setSelected, expanded, memberPaths, editing: !!editing, cancelEdit,
    filter, filterOpen, setFilter, closeFilter, root, toggleFileMembers, toggle, toggleVisibleRow,
    onOpen, isEditable, beginRename, askDelete,
  });

  const handlers = useTreeHandlers({
    toggleRow: toggleVisibleRow, toggle, onOpen, onPin, openMenu, commitEdit, cancelEdit, setSelected, isEditable, toggleMembers,
  });

  const ctx: TreeRowsCtx = useMemo(() => ({
    dirs,
    expanded,
    selectedPath: selected?.path ?? null,
    marks,
    bookmarkCounts,
    filter: filterFn,
    problemPaths: problemMarks.paths, problemPackages: problemMarks.packages,
    packageView, showCommitAuthors,
    compact, packageRoots, packageIndexes,
    hoist,
    members: packageView ? members : undefined,
    isBcModule,
    bcNames,
    editing,
    editError,
    busy,
    ...handlers,
  }), [dirs, expanded, selected?.path, marks, bookmarkCounts, filterFn, problemMarks.paths, problemMarks.packages,
    packageView, showCommitAuthors, compact, packageRoots, packageIndexes, hoist, members, isBcModule, bcNames, editing, editError, busy, handlers]);

  return (
    <>
      <TreeHeader root={root} projectCount={projects?.length} canCollapse={collapseEnabled} onCollapseAll={collapseAll}
        onCreateFile={() => startCreate("file")} onCreateDir={() => startCreate("dir")} />
      <TreeViewFilters mode={mode} onToggle={toggleMode} />
      <TreeQuickFilter root={root} onNavigate={keys.navigate} />
      <TreeActivePath path={activePath}><div
        ref={treeList}
        className="wb-tree-list"
        data-package-view={packageView || undefined}
        role="tree"
        aria-label={packageView ? "包资源管理器" : "文件树"}
        tabIndex={0}
        aria-activedescendant={selected && flat.some(row => row.path === selected.path) ? rowId(selected.path) : undefined}
        onKeyDown={keys.onKeyDown}
        onContextMenu={(e) => {
          // 空白处右键 = 对工作区根操作（新建到根下）
          if (e.target === e.currentTarget) openMenu(e, root, true);
        }}
      >
        {mode === "changes" && !changeCount ? (
          <div className="wb-row-note" role="status">当前没有可显示的 SVN 改动</div>
        ) : mode === "problems" && !problemMarks.paths.size ? (
          <div className="wb-row-note" role="status">当前没有已报告的错误或警告</div>
        ) : multi || packageView ? (
          <TreeProjectRows projects={multi ? projects : undefined} root={root} ctx={ctx} />
        ) : (
          <TreeRows dir={root} depth={0} ctx={ctx} />
        )}
      </div></TreeActivePath>

      {packageView && !mode && <PackageDependencies key={root} root={root} projects={rootRows} />}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={closeMenu} />
      )}
      {history && <Suspense fallback={null}>
        <TreeSvnHistory path={history.path} revision={history.revision} onClose={closeHistory} />
      </Suspense>}

      <TreeDeleteConfirm pending={pendingDelete} onCancel={cancelDelete} onConfirm={() => void confirmDelete()} />
      {newJavaDialog}
    </>
  );
}
