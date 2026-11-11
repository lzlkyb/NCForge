import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ContextMenu } from "./ContextMenu";
import { TreeDeleteConfirm, TreeProblemToggle } from "./TreeChrome";
import { TreeRows, type TreeRowsCtx } from "./TreeRows";
import { PackageDependencies } from "./PackageDependencies";
import { TreeProjectRows } from "./TreeProjectRows";
import { TreeQuickFilter } from "./TreeQuickFilter";
import { useTreeFilterState } from "../../lib/treeFilter";
import { useTreeDelete } from "./useTreeDelete";
import { useTreeEdit } from "./useTreeEdit";
import { useTreeMembers } from "../../hooks/useTreeMembers";
import { useTreeLoad } from "./useTreeLoad";
import { useTreeHandlers } from "./useTreeHandlers";
import { packageCompact, packageDepthOffset } from "../../lib/packageTree";
import { useNcComponents } from "../../hooks/useNcComponents";
import { useTreeMenu } from "../../hooks/useTreeMenu";
import { useProblemMarks, useProblemTreeFilter } from "../../hooks/useProblemMarks";
import { useTreeLocate } from "../../hooks/useTreeLocate";
import type { NewEntryKind } from "../../lib/workspace";
import { useTreeNewJava } from "../../hooks/useTreeNewJava";
import { flattenTree, treeKeyAction, treeRowId as rowId } from "../../lib/treeNav";
import { countBookmarks, useBookmarks } from "../../lib/bookmarks";
import { useCompactPackages, useNcStructure, usePackageView, useRevealOnOpen } from "../../lib/treeViewPrefs";
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

export interface FileTreeHandle {
  /** 在当前选中项下开始新建（没选中就用根目录）。 */
  startCreate: (kind: NewEntryKind) => void;
}

/**
 * 目录和 Java 成员按展开加载，避免首次打开大工程时预读全部源码。
 * 文件夹展开态和缓存放在 workspaceSession，切换侧栏后仍可复用。
 */
export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree(
  { root, projects, activePath, onOpen, onPin, onCreated, onRenamed, onDeleted, openPaths, onCompileModule, onCleanModule, onRebuildModule },
  ref,
) {
  const [selected, setSelected] = useState<{ path: string; isDir: boolean } | null>(null);
  const [filter, setFilter] = useTreeFilterState(root);
  const problemMarks = useProblemMarks();
  const compact = useCompactPackages();
  const ncStructure = useNcStructure();
  const packageView = usePackageView();
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
  const { dirs, expanded, marks, onlyProblems, setOnlyProblems, load, expand, toggle, toggleRow, depthOf, reveal, packageRoots, packageIndexes, invalidatePackages } = useTreeLoad(
    root,
    compact,
    roots,
    hoist, packageView,
  );
  const toggleVisibleRow = (path: string, parent: string | null) => {
    if (packageView && packageIndexes.get(path) === null && !expanded.has(path)) void invalidatePackages([path], false, false);
    if (packageCompact(packageRoots, path, packageIndexes)) toggleRow(path, parent);
    else toggle(path);
  };
  const { members, toggle: toggleMembers } = useTreeMembers(packageView, dirs);
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

  // 清筛选的引用要稳定：它进了 locate 的依赖，每帧换新会让自动定位反复触发
  const clearFilter = useCallback(() => setFilter(""), [setFilter]);
  useTreeLocate(reveal, activePath, revealOnOpen, clearFilter);

  const { openNewJava, newJavaDialog } = useTreeNewJava({
    root, load, expand, setSelected, onCreated,
    onEntryCreated: path => { if (packageView) invalidatePackages([path]); },
  });
  const { menu, menuItems, openMenu, closeMenu } = useTreeMenu({
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

  useImperativeHandle(ref, () => ({
    startCreate: (kind) => {
      // 选中的是关联工程的目录时，新建会落到当前工作区根：后端只允许写当前工程
      const target =
        selected && isEditable(selected.path) ? selected : { path: root, isDir: true };
      beginCreate(target, kind);
    },
  }));

  // ---- 键盘与筛选 ----

  const filterFn = useProblemTreeFilter(filter, onlyProblems, problemMarks);
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

  // 焦点留在容器，方向键按视觉树移动。
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.target as HTMLElement).closest(".wb-problem-badge") || editing || e.nativeEvent.isComposing) return;
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
    if (e.key.length === 1 && (e.key !== " " || filter) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setFilter((f) => f + e.key);
      return;
    }
    const act = treeKeyAction(e.key, flat, selected, new Set([...expanded, ...members.keys()]));
    if (act) {
      e.preventDefault();
      if (act.kind === "select") setSelected({ path: act.path, isDir: act.isDir });
      else if (act.kind === "toggle") {
        const row = flat.find((r) => r.path === act.path);
        // 工程根行不参与压缩链：点一下只展开这一层
        if (row?.branch === "java-file") toggleFileMembers(act.path);
        else if (row?.project) toggle(act.path);
        // NC 结构视图摊平后的行真身在 `bill/src` 下，问压缩链要用真实父目录
        else toggleVisibleRow(act.path, row?.realParent ?? row?.parent ?? root);
      } else {
        const symbol = flat.find(row => row.path === act.path)?.symbol;
        if (symbol) onOpen(symbol.file, { line: symbol.line, column: symbol.column });
        else onOpen(act.path);
      }
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

  const handlers = useTreeHandlers({
    toggleRow: toggleVisibleRow, toggle, onOpen, onPin, openMenu, commitEdit, cancelEdit, setSelected, isEditable,
  });

  const ctx: TreeRowsCtx = {
    dirs,
    expanded,
    activePath,
    selectedPath: selected?.path ?? null,
    marks,
    bookmarkCounts,
    filter: filterFn,
    problemPaths: problemMarks.paths, problemPackages: problemMarks.packages,
    compact, packageRoots, packageIndexes,
    hoist,
    members: packageView ? members : undefined,
    onToggleMembers: toggleFileMembers,
    onOpenMember: (path, member) => {
      setSelected({ path: member.id, isDir: false });
      onOpen(path, { line: member.line, column: member.column });
    },
    isBcModule,
    bcNames,
    editing,
    editError,
    busy,
    ...handlers,
  };

  return (
    <>
      <TreeProblemToggle active={onlyProblems} onToggle={() => setOnlyProblems(!onlyProblems)} />
      <TreeQuickFilter root={root} />
      <div
        className="wb-tree-list"
        role="tree"
        aria-label={packageView ? "包资源管理器" : "文件树"}
        tabIndex={0}
        aria-activedescendant={selected && flat.some(row => row.path === selected.path) ? rowId(selected.path) : undefined}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          // 空白处右键 = 对工作区根操作（新建到根下）
          if (e.target === e.currentTarget) openMenu(e, root, true);
        }}
      >
        {onlyProblems && !problemMarks.paths.size ? (
          <div className="wb-row-note" role="status">当前没有已报告的错误或警告</div>
        ) : multi || packageView ? (
          <TreeProjectRows projects={multi ? projects : undefined} root={root} ctx={ctx} />
        ) : (
          <TreeRows dir={root} depth={0} ctx={ctx} />
        )}
      </div>

      {packageView && !onlyProblems && <PackageDependencies key={root} root={root} projects={rootRows} />}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={closeMenu} />
      )}

      <TreeDeleteConfirm pending={pendingDelete} onCancel={cancelDelete} onConfirm={() => void confirmDelete()} />
      {newJavaDialog}
    </>
  );
});
