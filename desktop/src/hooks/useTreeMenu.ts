import { useState, type MouseEvent } from "react";
import { toast } from "../components/ui/toast";
import type { ContextMenuItem } from "../components/workspace/ContextMenu";
import { buildTreeMenu } from "../components/workspace/treeMenu";
import { dirName, type NewEntryKind } from "../lib/workspace";

export interface TreeMenuTarget {
  path: string;
  isDir: boolean;
}

/**
 * 文件树的右键菜单：位置状态、菜单项构造与「复制路径」。
 *
 * 从 `FileTree` 抽出来是因为组件体量门禁；顺带让菜单的只读判断（`canEdit`）
 * 只有一处入口——关联工程的文件不允许新建/改名/删除，后端也必拒。
 */
export function useTreeMenu({
  root,
  isEditable,
  onOpen,
  beginCreate,
  beginRename,
  askDelete,
  load,
  setSelected,
}: {
  root: string;
  isEditable: (path: string) => boolean;
  onOpen: (path: string) => void;
  beginCreate: (target: TreeMenuTarget, kind: NewEntryKind) => void;
  beginRename: (target: TreeMenuTarget) => void;
  askDelete: (target: TreeMenuTarget) => Promise<void>;
  load: (path: string) => Promise<void>;
  setSelected: (target: TreeMenuTarget) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(
    null,
  );

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast("已复制路径", "success");
    } catch {
      toast("复制失败：系统剪贴板不可用", "error");
    }
  };

  const menuItems = (m: TreeMenuTarget): ContextMenuItem[] =>
    buildTreeMenu({
      target: m,
      root,
      canEdit: isEditable(m.path),
      onOpen,
      onBeginCreate: beginCreate,
      onBeginRename: beginRename,
      onDelete: (t) => void askDelete(t),
      onCopyPath: (p) => void copyPath(p),
      onRefresh: (t) => void load(t.isDir ? t.path : dirName(t.path)),
    });

  const openMenu = (e: MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected({ path, isDir });
    setMenu({ x: e.clientX, y: e.clientY, path, isDir });
  };

  return { menu, menuItems, openMenu, closeMenu: () => setMenu(null) };
}
