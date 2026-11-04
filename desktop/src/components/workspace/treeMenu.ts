import type { ContextMenuItem } from "./ContextMenu";
import type { NewEntryKind } from "../../lib/workspace";

/**
 * 树节点右键菜单的条目。抽出来只为让 `FileTree` 专注渲染与状态编排——
 * 这里全是「动作接线」，改菜单不需要碰组件。
 */
export function buildTreeMenu({
  target,
  root,
  canEdit = true,
  module = null,
  onOpen,
  onCompileModule,
  onBeginCreate,
  onBeginRename,
  onDelete,
  onCopyPath,
  onRefresh,
}: {
  target: { path: string; isDir: boolean };
  root: string;
  /**
   * 这一项是否可写（默认 true）。关联工程的根不在当前工作区白名单里：
   * 新建 / 改名 / 删除都会被后端拒绝，菜单里就不该摆出来。
   */
  canEdit?: boolean;
  /**
   * 右键目标所属的模块名（`lib/ncModule::moduleOf`）；`null` = 不在工作区的任何模块里
   * （工作区根、关联工程的文件），此时不显示编译项——后端也一定会拒。
   */
  module?: string | null;
  onOpen: (path: string) => void;
  /** 编译这个模块。**不依赖活动标签**：批量替换完想验证某个模块能不能编时用。 */
  onCompileModule?: (path: string) => void;
  onBeginCreate: (target: { path: string; isDir: boolean }, kind: NewEntryKind) => void;
  onBeginRename: (target: { path: string; isDir: boolean }) => void;
  onDelete: (target: { path: string; isDir: boolean }) => void;
  onCopyPath: (path: string) => void;
  onRefresh: (target: { path: string; isDir: boolean }) => void;
}): ContextMenuItem[] {
  const atRoot = target.path === root;
  const items: ContextMenuItem[] = [];
  if (target.isDir) {
    if (canEdit) {
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
    }
  } else {
    items.push({ label: "打开", icon: "file", onSelect: () => onOpen(target.path) });
  }
  // 编译项紧跟在「打开/新建」之后：它是对这个模块整体做的事，与后面的改名删除不是一类。
  // 标出模块名（`编译模块 bill`）而不是只写「编译」——右键的是 `src/public` 时，
  // 用户得知道这一下编的是整个模块。
  if (module && onCompileModule) {
    items.push({
      label: `编译模块 ${module}`,
      icon: "hammer",
      separator: items.length > 0,
      onSelect: () => onCompileModule(target.path),
    });
  }
  items.push({
    label: "重命名",
    icon: "edit",
    hint: "F2",
    separator: items.length > 0,
    disabled: atRoot || !canEdit,
    onSelect: () => onBeginRename(target),
  });
  items.push({
    label: "删除",
    icon: "trash",
    hint: "Del",
    danger: true,
    disabled: atRoot || !canEdit,
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
