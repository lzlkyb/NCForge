import {
  useCallback,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";
import { treeKeyAction, treeRowId, type FlatRow, type TreeSelection } from "../../lib/treeNav";

export interface TreeKeyDeps {
  flat: FlatRow[];
  selected: TreeSelection | null;
  setSelected: (value: TreeSelection | null) => void;
  expanded: Set<string>;
  /** 已展开成员的 Java 文件：方向键要把它们的成员行也算进可见序列。 */
  memberPaths: Set<string>;
  /** 树里有内联输入行（新建 / 改名）正在编辑。 */
  editing: boolean;
  cancelEdit: () => void;
  filter: string;
  /** 过滤条本身开着（文字可能已经清空）。 */
  filterOpen: boolean;
  setFilter: Dispatch<SetStateAction<string>>;
  closeFilter: () => void;
  root: string;
  toggleFileMembers: (path: string) => void;
  toggle: (path: string) => void;
  toggleVisibleRow: (path: string, parent: string | null) => void;
  onOpen: (path: string, pos?: { line: number; column: number }) => void;
  isEditable: (path: string) => boolean;
  beginRename: (target: TreeSelection) => void;
  askDelete: (target: TreeSelection) => void;
}

/**
 * 文件树的键盘导航（speed search + 方向键 + F2/Delete）。
 *
 * 从 `FileTree` 抽出来有两个原因：那个组件已经顶到 300 行体量门禁；以及这里有三条
 * 反复踩过的经验要固化在一处：
 *
 * 1. **编辑态只让 Escape 走**。以前所有按键在 `editing` 时直接 `return`，于是
 *    「选中文件 → 收起它所在的目录 → F2」留下的输入行渲染不出来，而 Esc 也被吞掉，
 *    整棵树等于卡死（只能切页或重启）。输入行自己处理 Enter/Esc，这里只兜底取消。
 * 2. **移动后滚到可见**。键盘走过的行若在视口外，用户看不到焦点落在哪。
 * 3. **导航要能被筛选框复用**（`navigate`）。焦点在过滤输入框里时，↑↓/Enter 仍然
 *    该操作树；否则那个框一打开，整棵树的键盘导航就全废了。
 */
export function useTreeKeyboard(deps: TreeKeyDeps) {
  const {
    flat, selected, setSelected, expanded, memberPaths, editing, cancelEdit,
    filter, filterOpen, setFilter, closeFilter, root, toggleFileMembers, toggle, toggleVisibleRow,
    onOpen, isEditable, beginRename, askDelete,
  } = deps;

  const scrollTo = useCallback((path: string) => {
    // jsdom 没有 scrollIntoView；真实环境里它保证键盘焦点不会停在视口外
    document.getElementById(treeRowId(path))?.scrollIntoView?.({ block: "nearest" });
  }, []);

  /** 把一次按键翻译成树动作。返回 true = 这个键被树吃掉了。 */
  const navigate = useCallback((key: string): boolean => {
    const act = treeKeyAction(key, flat, selected, new Set([...expanded, ...memberPaths]));
    if (!act) return false;
    if (act.kind === "select") {
      setSelected({ path: act.path, isDir: act.isDir });
      scrollTo(act.path);
    } else if (act.kind === "toggle") {
      const row = flat.find((r) => r.path === act.path);
      // 工程根行不参与压缩链：点一下只展开这一层
      if (row?.branch === "java-file") toggleFileMembers(act.path);
      else if (row?.project) toggle(act.path);
      // NC 结构视图摊平后的行真身在 `bill/src` 下，问压缩链要用真实父目录
      else toggleVisibleRow(act.path, row?.realParent ?? row?.parent ?? root);
    } else {
      const symbol = flat.find((row) => row.path === act.path)?.symbol;
      if (symbol) onOpen(symbol.file, { line: symbol.line, column: symbol.column });
      else onOpen(act.path);
    }
    return true;
  }, [flat, selected, expanded, memberPaths, setSelected, scrollTo, toggleFileMembers, toggle, toggleVisibleRow, onOpen, root]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if ((e.target as HTMLElement).closest(".wb-problem-badge") || e.nativeEvent.isComposing) return;
    if (editing) {
      if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
      return;
    }
    // Escape 三档：先清词、再收条、最后取消选中。只清词不收条的话，speed search
    // 之后那条空过滤条会一直挂在树上，而焦点在树里根本没有别的入口能关它。
    if (e.key === "Escape") {
      if (filter) { e.preventDefault(); setFilter(""); return; }
      if (filterOpen) { e.preventDefault(); closeFilter(); return; }
    }
    if (e.key === "Backspace" && filter) {
      e.preventDefault();
      setFilter((f) => f.slice(0, -1));
      return;
    }
    // speed search：单字符直接进筛选框（空格只在已有筛选时算字符，否则留给滚动）
    if (e.key.length === 1 && (e.key !== " " || filter) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setFilter((f) => f + e.key);
      return;
    }
    if (navigate(e.key)) {
      e.preventDefault();
      return;
    }
    // 选中行被收起或被筛掉时看不见它，改名 / 删除没有可操作的目标
    if (!selected || !flat.some((row) => row.path === selected.path)) return;
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
  }, [editing, cancelEdit, filter, filterOpen, setFilter, closeFilter, navigate, selected, flat, isEditable, beginRename, askDelete, setSelected]);

  return { onKeyDown, navigate };
}
