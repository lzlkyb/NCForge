import { useCallback, useState } from "react";
import {
  baseName,
  createEntry,
  dirName,
  remapPath,
  renameEntry,
  validateEntryName,
  type EncodingMark,
  type NewEntryKind,
} from "../../lib/workspace";
import { setTree, type TreeDirState } from "../../lib/workspaceSession";

/** 正在输入的那一行：新建（文件/文件夹）或重命名。 */
export interface EditState {
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

/** 新建 / 重命名的状态机。树里原地输入，不弹对话框。 */
export function useTreeEdit({
  root,
  dirs,
  load,
  expand,
  depthOf,
  onCreated,
  onRenamed,
  setSelected,
}: {
  root: string;
  dirs: Record<string, TreeDirState>;
  load: (path: string) => Promise<void>;
  expand: (path: string) => void;
  depthOf: (path: string) => number;
  onCreated: (path: string) => void;
  onRenamed: (oldPath: string, newPath: string) => void;
  setSelected: (value: { path: string; isDir: boolean } | null) => void;
}) {
  const [editing, setEditing] = useState<EditState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        if (isDir) {
          // 只展开不拉取：dirs[created] 缓存永远不存在，FileTree 把 !state 也画成
          // 「加载中…」，而 toggle 只在「未展开且未加载」时才请求——用户必须手动
          // 折叠再展开才能看到内容。
          expand(created);
          void load(created);
        } else onCreated(created);
      }
    } catch (e) {
      // 后端的文案（重名、非法字符、权限）直接显示在输入行下面
      setEditError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return { editing, editError, busy, beginCreate, beginRename, cancelEdit, commitEdit };
}
