import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  baseName,
  countFiles,
  createEntry,
  deleteEntry,
  dirName,
  encodingMarks,
  joinPath,
  listDir,
  remapPath,
  renameEntry,
  splitFileName,
  validateEntryName,
  type DirItem,
  type EncodingMark,
  type NewEntryKind,
} from "../../lib/workspace";
import {
  getSession,
  setSession,
  setTree,
  useWorkspaceSession,
  type TreeDirState,
} from "../../lib/workspaceSession";

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

/** 正在输入的那一行：新建（文件/文件夹）或重命名。 */
interface EditState {
  mode: "create-file" | "create-dir" | "rename";
  /** 新条目的父目录；重命名时是被改名项所在目录。 */
  parent: string;
  /** 这一行的左内边距，跟它要替换/占据的那一行对齐。 */
  padLeft: number;
  isDir: boolean;
  /** 重命名时的原路径。 */
  target?: string;
  /** 输入框初始值；重命名时还用来判断「名字没改」。新建时留空，只给占位提示。 */
  initial: string;
  placeholder?: string;
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
 */
export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree(
  { root, activePath, onOpen, onCreated, onRenamed, onDeleted, openPaths },
  ref,
) {
  const { tree } = useWorkspaceSession();
  const { dirs, expanded, marks } = tree;

  const [selected, setSelected] = useState<{ path: string; isDir: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(
    null,
  );
  const [editing, setEditing] = useState<EditState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    path: string;
    isDir: boolean;
    files: number;
    labels: number;
  } | null>(null);

  // openPaths 只在弹删除确认时读一次；用 ref 存最新值，免得每次开标签都把整棵树的回调重建一遍
  const openPathsRef = useRef(openPaths);
  openPathsRef.current = openPaths;

  /**
   * 问后端这一层的 `.java` 里，哪些是「磁盘 UTF-8、Eclipse 却按 GBK 读」。
   *
   * 跟列目录分开跑：列表先出来，标记晚一拍到，展开目录不会等它。失败就当没有标记——
   * 这是提示，不该因为它让目录打不开。
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

  const load = useCallback(async (path: string) => {
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
  }, [markEncodings]);

  // 工作区根变化（首次打开 / 更换目录）时重置整棵树，只展开根。
  // 根没变（= 只是切页面回来）就直接复用缓存，不再打一次 IPC。
  useEffect(() => {
    const cached = getSession().tree;
    if (cached.root === root && cached.dirs[root]) return;
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

  // ---- 新建 / 重命名 ----

  const beginCreate = (target: { path: string; isDir: boolean }, kind: NewEntryKind) => {
    const parent = target.isDir ? target.path : dirName(target.path);
    const childDepth = depthOf(parent) + 1;
    setEditError(null);
    setEditing({
      mode: kind === "dir" ? "create-dir" : "create-file",
      parent,
      padLeft: 6 + childDepth * 14 + (kind === "dir" ? 0 : 20),
      isDir: kind === "dir",
      // 占位提示要短：深层目录下输入框只剩 90px 左右，长文案会被截成半句
      initial: "",
      placeholder: kind === "dir" ? "文件夹名" : "文件名",
    });
    expand(parent);
    if (dirs[parent]?.status !== "ok") void load(parent);
  };

  const beginRename = (target: { path: string; isDir: boolean }) => {
    if (target.path === root) return; // 工作区根不给改名，后端也会拒
    const parent = dirName(target.path);
    const parentDepth = depthOf(parent) + 1;
    setEditError(null);
    setEditing({
      mode: "rename",
      parent,
      padLeft: 6 + parentDepth * 14 + (target.isDir ? 0 : 20),
      isDir: target.isDir,
      target: target.path,
      initial: baseName(target.path),
    });
  };

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setEditError(null);
  }, []);

  /** 目录改名后，展开态与目录缓存的键全都要跟着挪，否则子树会塌回根。 */
  const remapTree = (from: string, to: string) =>
    setTree((t) => {
      const nextExpanded = new Set<string>();
      t.expanded.forEach((p) => nextExpanded.add(remapPath(p, from, to)));
      const nextDirs: Record<string, TreeDirState> = {};
      for (const [k, v] of Object.entries(t.dirs)) nextDirs[remapPath(k, from, to)] = v;
      const nextMarks: Record<string, EncodingMark> = {};
      for (const [k, v] of Object.entries(t.marks)) nextMarks[remapPath(k, from, to)] = v;
      return { ...t, expanded: nextExpanded, dirs: nextDirs, marks: nextMarks };
    });

  const commitEdit = async (value: string) => {
    if (!editing || busy) return;
    const err = validateEntryName(value);
    if (err) {
      setEditError(err);
      return;
    }
    if (editing.mode === "rename") {
      if (value === editing.initial) {
        cancelEdit();
        return;
      }
    }
    setBusy(true);
    setEditError(null);
    try {
      if (editing.mode === "rename" && editing.target) {
        const oldPath = editing.target;
        const isDir = editing.isDir;
        const newPath = await renameEntry(oldPath, value);
        setEditing(null);
        remapTree(oldPath, newPath);
        onRenamed(oldPath, newPath);
        setSelected({ path: newPath, isDir });
        await load(dirName(newPath));
      } else {
        const parent = editing.parent;
        const isDir = editing.isDir;
        const created = await createEntry(parent, value, isDir ? "dir" : "file");
        setEditing(null);
        expand(parent);
        await load(parent);
        setSelected({ path: created, isDir });
        if (isDir) expand(created);
        else onCreated(created);
      }
    } catch (e) {
      // 后端的文案（重名、非法字符、权限）直接显示在输入行下面
      setEditError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- 删除 ----

  const askDelete = async (target: { path: string; isDir: boolean }) => {
    if (target.path === root) return;
    let files = 1;
    if (target.isDir) {
      try {
        files = await countFiles(target.path);
      } catch (e) {
        toast(`读取文件数失败：${e}`, "error");
        return;
      }
    }
    const lower = target.path.toLowerCase();
    const labels = openPathsRef.current.filter((p) => {
      const pl = p.toLowerCase();
      return pl === lower || pl.startsWith(`${lower}\\`);
    }).length;
    setPendingDelete({ ...target, files, labels });
  };

  /** 删掉目录后，缓存里以它为前缀的键都失效了。 */
  const dropTree = (path: string) =>
    setTree((t) => {
      const lower = path.toLowerCase();
      const keep = (p: string) => {
        const pl = p.toLowerCase();
        return !(pl === lower || pl.startsWith(`${lower}\\`));
      };
      const nextDirs: Record<string, TreeDirState> = {};
      for (const [k, v] of Object.entries(t.dirs)) if (keep(k)) nextDirs[k] = v;
      const nextMarks: Record<string, EncodingMark> = {};
      for (const [k, v] of Object.entries(t.marks)) if (keep(k)) nextMarks[k] = v;
      return {
        ...t,
        dirs: nextDirs,
        marks: nextMarks,
        expanded: new Set([...t.expanded].filter(keep)),
      };
    });

  const confirmDelete = async () => {
    const d = pendingDelete;
    if (!d) return;
    setPendingDelete(null);
    try {
      await deleteEntry(d.path, d.isDir);
      if (d.isDir) dropTree(d.path);
      onDeleted([d.path]);
      setSelected(null);
      await load(dirName(d.path));
      toast(`已删除 ${baseName(d.path)}`, "success");
    } catch (e) {
      toast(`删除失败：${e}`, "error");
    }
  };

  // ---- 菜单 ----

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast("已复制路径", "success");
    } catch {
      toast("复制失败：系统剪贴板不可用", "error");
    }
  };

  const menuItems = (m: { path: string; isDir: boolean }): ContextMenuItem[] => {
    const atRoot = m.path === root;
    const items: ContextMenuItem[] = [];
    if (m.isDir) {
      items.push({
        label: "新建文件",
        icon: "filePlus",
        hint: "Ctrl+N",
        onSelect: () => beginCreate(m, "file"),
      });
      items.push({
        label: "新建文件夹",
        icon: "folderPlus",
        onSelect: () => beginCreate(m, "dir"),
      });
    } else {
      items.push({ label: "打开", icon: "file", onSelect: () => onOpen(m.path) });
    }
    items.push({
      label: "重命名",
      icon: "edit",
      hint: "F2",
      separator: true,
      disabled: atRoot,
      onSelect: () => beginRename(m),
    });
    items.push({
      label: "删除",
      icon: "trash",
      hint: "Del",
      danger: true,
      disabled: atRoot,
      onSelect: () => void askDelete(m),
    });
    items.push({
      label: "复制路径",
      icon: "copy",
      separator: true,
      onSelect: () => void copyPath(m.path),
    });
    items.push({
      label: "刷新",
      icon: "refresh",
      onSelect: () => void load(m.isDir ? m.path : dirName(m.path)),
    });
    return items;
  };

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

  const editRow = (st: EditState) => (
    <Fragment key={`edit-${st.mode}-${st.target ?? st.parent}`}>
      <EditRow
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
    // 新建的输入行出现在该目录内容的最前面
    if (editing && editing.mode !== "rename" && editing.parent === path) rows.push(editRow(editing));
    if (!state || state.status === "loading") {
      rows.push(
        <div key={`${path}#l`} className="wb-row-note" style={{ paddingLeft: 6 + depth * 14 + 20 }}>
          加载中…
        </div>,
      );
      return rows;
    }
    if (state.status === "error") {
      rows.push(
        <div
          key={`${path}#e`}
          className="wb-row-note"
          data-tone="bad"
          style={{ paddingLeft: 6 + depth * 14 + 20 }}
          title={state.message}
        >
          读取失败：{state.message}
        </div>,
      );
      return rows;
    }
    if (state.items.length === 0 && !(editing && editing.parent === path)) {
      rows.push(
        <div key={`${path}#0`} className="wb-row-note" style={{ paddingLeft: 6 + depth * 14 + 20 }}>
          （空目录）
        </div>,
      );
    }
    for (const item of state.items) {
      const full = joinPath(path, item.name);
      const pad = { paddingLeft: 6 + depth * 14 };
      if (editing && editing.mode === "rename" && editing.target?.toLowerCase() === full.toLowerCase()) {
        rows.push(editRow(editing));
        continue;
      }
      if (item.isDir) {
        const open = expanded.has(full);
        rows.push(
          <button
            key={full}
            type="button"
            className="wb-row"
            style={pad}
            data-selected={selected?.path === full || undefined}
            onClick={() => {
              setSelected({ path: full, isDir: true });
              toggle(full);
            }}
            onContextMenu={(e) => openMenu(e, full, true)}
            aria-expanded={open}
            title={item.name}
          >
            <Icon name="chevronDown" size={14} className={`wb-row-icon ${open ? "" : "-rotate-90"}`} />
            <Icon name="folder" size={14} className="wb-row-icon" />
            <span className="wb-row-name">{item.name}</span>
          </button>,
        );
        if (open) rows.push(...renderDir(full, depth + 1));
      } else {
        const mark = marks[full];
        rows.push(
          <button
            key={full}
            type="button"
            className="wb-row"
            style={{ paddingLeft: 6 + depth * 14 + 20 }}
            data-active={activePath === full || undefined}
            data-selected={selected?.path === full || undefined}
            onClick={() => {
              setSelected({ path: full, isDir: false });
              onOpen(full);
            }}
            onContextMenu={(e) => openMenu(e, full, false)}
            title={mark ? `${item.name}\n${encodingHint(mark)}` : item.name}
          >
            <Icon name="file" size={14} className="wb-row-icon" />
            <span className="wb-row-name">{item.name}</span>
            {mark && (
              // 「UTF-8!」四个字要占 40 多像素，在六层目录下会把文件名挤成「Vouc…」。
              // 缩成 U8，完整说明放在行的 title 里。
              <span className="wb-enc-badge" title={encodingHint(mark)}>
                U8
              </span>
            )}
          </button>,
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
        onCancel={() => setPendingDelete(null)}
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

/**
 * 树上 `UTF-8!` 的悬停说明：说清「为什么标」以及「谁的产物是对的」。
 * 用原生 title（多行用 \n 分隔），不值得为一行提示再写一套浮层。
 */
function encodingHint(m: EncodingMark): string {
  const where = m.registered ? `登记为 ${m.registered}` : "没有登记";
  return [
    `这个文件是 UTF-8，但 Eclipse 编码偏好里${where}，Eclipse 会按工程默认的 GBK 读。`,
    "用 Eclipse 编译时，里面的中文字符串常量会变成乱码；NCForge 按 UTF-8 处理，产物是对的。",
  ].join("\n");
}

/**
 * 树里的内联输入行。Enter 提交、Esc 取消、点到别处也取消（宁可不建，也不要误建）。
 *
 * ✓ / ✕ 按钮用 onMouseDown preventDefault：否则按下按钮时输入框先失焦，
 * 「失焦取消」抢在 click 前面跑，按钮就永远点不到。
 */
function EditRow({
  initial,
  placeholder,
  selectStem,
  isDir,
  padLeft,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  selectStem: boolean;
  isDir: boolean;
  padLeft: number;
  error: string | null;
  busy: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const { stem } = splitFileName(initial);
    // 重命名只选中主名，扩展名留着不动；其他情况（含新建默认名）整体选中，打字即替换
    if (selectStem && stem.length === initial.length) el.select();
    else if (selectStem) el.setSelectionRange(0, stem.length);
    else el.select();
  }, [initial, selectStem]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onCancel();
    };
    // 延到下一轮事件循环再挂：打开输入行的那次 mousedown 还在冒泡，会立刻把它关掉
    const id = window.setTimeout(() => window.addEventListener("mousedown", onDown, true), 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onCancel]);

  return (
    <>
      <div
        ref={boxRef}
        className="wb-tree-edit"
        style={{ paddingLeft: padLeft }}
        data-bad={error ? true : undefined}
      >
        {/* ✓ / ✕ 放在输入框内部：树只有 240px，放到外面会把深层目录的输入框挤没 */}
        <div className="wb-tree-edit-field">
          <Icon name={isDir ? "folder" : "file"} size={13} className="wb-row-icon" />
          <input
            ref={inputRef}
            className="wb-tree-edit-input"
            value={value}
            placeholder={placeholder}
            disabled={busy}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit(value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              }
            }}
          />
          <button
            type="button"
            className="wb-tree-edit-btn"
            data-tone="ok"
            title="确定（Enter）"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSubmit(value)}
          >
            <Icon name="check" size={12} />
          </button>
          <button
            type="button"
            className="wb-tree-edit-btn"
            data-tone="no"
            title="取消（Esc）"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCancel}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </div>
      {error && (
        <div className="wb-tree-edit-err" style={{ paddingLeft: padLeft + 12 }}>
          {error}
        </div>
      )}
    </>
  );
}
