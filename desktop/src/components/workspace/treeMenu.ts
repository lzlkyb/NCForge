import type { ContextMenuItem } from "./ContextMenu";
import type { NewEntryKind } from "../../lib/workspace";

/**
 * 树节点右键菜单的条目。抽出来只为让 `FileTree` 专注渲染与状态编排——
 * 这里全是「动作接线」，改菜单不需要碰组件。
 */
export function buildTreeMenu({
  target,
  root,
  onOpen,
  onBeginCreate,
  onBeginRename,
  onDelete,
  onCopyPath,
  onRefresh,
}: {
  target: { path: string; isDir: boolean };
  root: string;
  onOpen: (path: string) => void;
  onBeginCreate: (target: { path: string; isDir: boolean }, kind: NewEntryKind) => void;
  onBeginRename: (target: { path: string; isDir: boolean }) => void;
  onDelete: (target: { path: string; isDir: boolean }) => void;
  onCopyPath: (path: string) => void;
  onRefresh: (target: { path: string; isDir: boolean }) => void;
}): ContextMenuItem[] {
  const atRoot = target.path === root;
  const items: ContextMenuItem[] = [];
  if (target.isDir) {
    items.push({
      label: "新建文件",
      icon: "filePlus",
      // 不标 Ctrl+N：全局没有这个快捷键，标了就是承诺一个不存在的操作
      onSelect: () => onBeginCreate(target, "file"),
    });
    items.push({
      label: "新建文件夹",
      icon: "folderPlus",
      onSelect: () => onBeginCreate(target, "dir"),
    });
  } else {
    items.push({ label: "打开", icon: "file", onSelect: () => onOpen(target.path) });
  }
  items.push({
    label: "重命名",
    icon: "edit",
    hint: "F2",
    separator: true,
    disabled: atRoot,
    onSelect: () => onBeginRename(target),
  });
  items.push({
    label: "删除",
    icon: "trash",
    hint: "Del",
    danger: true,
    disabled: atRoot,
    onSelect: () => onDelete(target),
  });
  items.push({
    label: "复制路径",
    icon: "copy",
    separator: true,
    onSelect: () => onCopyPath(target.path),
  });
  items.push({
    // 写清「刷的是哪个目录」：右键文件时刷的是它所在目录，
    // 否则用户会以为刷完文件内容就重新读了（其实读的是目录列表）
    label: target.isDir ? "刷新此目录" : "刷新所在目录",
    icon: "refresh",
    onSelect: () => onRefresh(target),
  });
  return items;
}
