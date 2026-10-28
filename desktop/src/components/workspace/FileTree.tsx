import {
  Fragment,
  forwardRef,
  useImperativeHandle,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { TreeEditRow } from "./TreeEditRow";
import { TreeDirRow, TreeFileRow, TreeRowNote } from "./TreeRow";
import { buildTreeMenu } from "./treeMenu";
import { useTreeDelete } from "./useTreeDelete";
import { useTreeEdit } from "./useTreeEdit";
import { useTreeLoad } from "./useTreeLoad";
import { baseName, dirName, joinPath, type NewEntryKind } from "../../lib/workspace";

interface Props {
  root: string;
  activePath: string | null;
  onOpen: (path: string) => void;
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

/**
 * 懒加载文件树：展开某个目录时才向后端请求这一层，不预读整棵树
 * （newar 约 7000 个源文件、几十个模块，整棵预读会卡首屏）。
 *
 * 展开态与已加载的目录存在 `lib/workspaceSession`：切页面会卸载本组件，
 * 状态要是留在 useState 里，从搜索页跳回来就得重新点开一遍。
 *
 * 新建 / 重命名都在树里原地输入（VS Code 那样），不弹对话框：
 * 建文件是个高频小动作，弹窗会打断节奏；删除才需要确认。
 *
 * 拆成三层：`useTreeLoad` 只管取数与展开，`useTreeEdit` 是就地输入的状态机，
 * `useTreeDelete` 是删除流程；行渲染在 `TreeRow` / `TreeEditRow` 里。
 */
export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree(
  { root, activePath, onOpen, onCreated, onRenamed, onDeleted, openPaths },
  ref,
) {
  const [selected, setSelected] = useState<{ path: string; isDir: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(
    null,
  );

  const { dirs, expanded, marks, load, expand, toggle, depthOf } = useTreeLoad(root);
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

  // ---- 键盘 ----

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (editing) return;
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

  const editRow = (st: NonNullable<typeof editing>) => (
    <Fragment key={`edit-${st.mode}-${st.target ?? st.parent}`}>
      <TreeEditRow
        initial={st.initial}
        placeholder={st.placeholder}
        selectStem={st.mode === "rename"}
        isDir={st.isDir}
        padLeft={st.padLeft}
        error={editError}
        busy={busy}
        onSubmit={(v) => void commitEdit(v)}
        onCancel={cancelEdit}
      />
    </Fragment>
  );

  const renderDir = (path: string, depth: number): JSX.Element[] => {
    const state = dirs[path];
    const rows: JSX.Element[] = [];
    const notePad = 6 + depth * 14 + 20;
    // 新建的输入行出现在该目录内容的最前面
    if (editing && editing.mode !== "rename" && editing.parent === path) rows.push(editRow(editing));
    if (!state || state.status === "loading") {
      rows.push(
        <TreeRowNote key={`${path}#l`} padLeft={notePad}>
          加载中…
        </TreeRowNote>,
      );
      return rows;
    }
    if (state.status === "error") {
      rows.push(
        <TreeRowNote key={`${path}#e`} padLeft={notePad} tone="bad" title={state.message}>
          读取失败：{state.message}
        </TreeRowNote>,
      );
      return rows;
    }
    if (state.items.length === 0 && !(editing && editing.parent === path)) {
      rows.push(
        <TreeRowNote key={`${path}#0`} padLeft={notePad}>
          （空目录）
        </TreeRowNote>,
      );
    }
    for (const item of state.items) {
      const full = joinPath(path, item.name);
      if (editing && editing.mode === "rename" && editing.target?.toLowerCase() === full.toLowerCase()) {
        rows.push(editRow(editing));
        continue;
      }
      if (item.isDir) {
        const open = expanded.has(full);
        rows.push(
          <TreeDirRow
            key={full}
            name={item.name}
            path={full}
            open={open}
            selected={selected?.path === full}
            padLeft={6 + depth * 14}
            onToggle={(p) => {
              setSelected({ path: p, isDir: true });
              toggle(p);
            }}
            onContextMenu={openMenu}
          />,
        );
        if (open) rows.push(...renderDir(full, depth + 1));
      } else {
        rows.push(
          <TreeFileRow
            key={full}
            name={item.name}
            path={full}
            active={activePath === full}
            selected={selected?.path === full}
            mark={marks[full]}
            padLeft={6 + depth * 14 + 20}
            onOpen={(p) => {
              setSelected({ path: p, isDir: false });
              onOpen(p);
            }}
            onContextMenu={openMenu}
          />,
        );
      }
    }
    return rows;
  };

  return (
    <>
      <div
        className="wb-tree-list"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          // 空白处右键 = 对工作区根操作（新建到根下）
          if (e.target === e.currentTarget) openMenu(e, root, true);
        }}
      >
        {renderDir(root, 0)}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除${pendingDelete?.isDir ? "文件夹" : "文件"} ${baseName(pendingDelete?.path ?? "")}？`}
        description={
          pendingDelete
            ? pendingDelete.isDir
              ? `共 ${pendingDelete.files} 个文件${pendingDelete.labels > 0 ? `，其中 ${pendingDelete.labels} 个已在标签中打开` : ""}。`
              : pendingDelete.labels > 0
                ? "这个文件正在标签里打开，删除后标签会一并关闭。"
                : undefined
            : undefined
        }
        variant="destructive"
        confirmLabel="删除"
        onCancel={cancelDelete}
        onConfirm={() => void confirmDelete()}
      >
        <div className="wb-danger-note">
          <Icon name="alertTriangle" size={13} />
          直接删除，不进回收站，无法撤销
        </div>
      </ConfirmDialog>
    </>
  );
});
