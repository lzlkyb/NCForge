import { useState, type MouseEvent } from "react";
import { toast } from "../components/ui/toast";
import type { ContextMenuItem } from "../components/workspace/ContextMenu";
import { buildTreeMenu } from "../components/workspace/treeMenu";
import { moduleOf } from "../lib/ncModule";
import { dirName, type NewEntryKind } from "../lib/workspace";
import type { ProblemMark } from "../lib/problemMarks";
import { diagnosticPathKey } from "../lib/diagnosticScope";
import { showProblems } from "../lib/showProblems";

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
  marks,
  isEditable,
  onOpen,
  onCompileModule,
  onCleanModule,
  onRebuildModule,
  beginCreate,
  onNewJavaType,
  beginRename,
  askDelete,
  load,
  setSelected,
}: {
  root: string;
  marks: ReadonlyMap<string, ProblemMark>;
  isEditable: (path: string) => boolean;
  onOpen: (path: string) => void;
  /** 编译右键目标所属的模块（不依赖活动标签）；不传则不显示编译项。 */
  onCompileModule?: (path: string) => void;
  onCleanModule?: (path: string, module: string) => void;
  onRebuildModule?: (path: string, module: string) => void;
  beginCreate: (target: TreeMenuTarget, kind: NewEntryKind) => void;
  onNewJavaType?: (target: TreeMenuTarget) => void;
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
      // 文件先取所在目录再判模块：直接拿文件路径算会得到「模块名 = 文件名」
      module: moduleOf(root, m.isDir ? m.path : dirName(m.path)),
      onCompileModule,
      onCleanModule,
      onRebuildModule,
      onOpen,
      onBeginCreate: beginCreate,
      onNewJavaType,
      onBeginRename: beginRename,
      onDelete: (t) => void askDelete(t),
      onCopyPath: (p) => void copyPath(p),
      onRefresh: (t) => void load(t.isDir ? t.path : dirName(t.path)),
      problemCount: (() => {
        if (m.isDir) return 0;
        const mark = marks.get(diagnosticPathKey(m.path));
        return mark ? mark.errors + mark.warnings : 0;
      })(),
      onShowProblems: showProblems,
    });

  const openMenu = (e: MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected({ path, isDir });
    setMenu({ x: e.clientX, y: e.clientY, path, isDir });
  };

  return { menu, menuItems, openMenu, closeMenu: () => setMenu(null) };
}
