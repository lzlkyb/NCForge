import { isReviewed, markReviewed } from "../../lib/reviewMarks";
import { revealInTree } from "../../lib/revealInTree";
import { relativeTo } from "../../lib/compile";
import { setSession } from "../../lib/workspaceSession";
import { pathKey } from "../../lib/treeSvn";
import type { StatusLetter } from "../../lib/svn";
import type { TabMeta } from "../../lib/workspaceSession";
import type { EditorGroupId } from "../../lib/editorGroups";
import { toast } from "../ui/toast";
import { svnCodeMenuItems } from "./svnCodeMenu";
import type { ContextMenuItem } from "./ContextMenu";

/**
 * 标签右键菜单的条目编排（从 `TabStrip` 抽出来的纯函数）。
 *
 * 抽出来不只是为了压行数：这里混着三种来源——标签自身的会话操作、SVN 写操作、
 * 已审标记——而 `TabStrip` 只管渲染。放在一处之后，「哪个条目该在什么条件下
 * 灰掉」能整块读，也方便单测。
 */
export interface TabMenuDeps {
  root: string;
  tabs: TabMeta[];
  splitPath: string | null;
  groupId?: EditorGroupId;
  onMoveGroup?: (path: string) => void;
  onClose: (path: string) => void;
  /** 批量关闭；未保存的保留。 */
  onCloseMany: (want: (t: TabMeta, index: number) => boolean) => void;
  onOpenSplit: (path: string) => void;
  onCloseSplit: () => void;
  copy: (text: string) => void;
  svnFiles: Map<string, StatusLetter>;
}

export function tabMenuItems(d: TabMenuDeps, path: string): ContextMenuItem[] {
  const i = d.tabs.findIndex((t) => t.path === path);
  const t = d.tabs[i];
  const virtual = !!t?.virtual;
  return [
    { label: "关闭", onSelect: () => d.onClose(path) },
    { label: "关闭其他", disabled: d.tabs.length < 2, onSelect: () => d.onCloseMany((x) => x.path !== path) },
    { label: "关闭右侧", disabled: i === d.tabs.length - 1, onSelect: () => d.onCloseMany((_, j) => j > i) },
    { label: "关闭已保存的", onSelect: () => d.onCloseMany(() => true) },
    // 文件树打开一律建固定标签（见 useProjectSwitch.openPath），不再有预览标签，
    // 原来的「保留预览标签」永远是灰的，删掉。
    {
      label: t?.pinned ? "取消钉住文件" : "钉住文件",
      separator: true,
      onSelect: () => setSession({
        tabs: prev => prev.map(tab => (tab.path === path ? { ...tab, pinned: !tab.pinned, preview: false } : tab)),
      }),
    },
    ...(d.onMoveGroup
      ? [{ label: d.groupId === "right" ? "移动到左组" : "移动到右组", onSelect: () => d.onMoveGroup!(path) }]
      : []),
    {
      label: d.splitPath === path ? "已在右侧分屏" : "在右侧打开",
      disabled: d.splitPath === path,
      onSelect: () => d.onOpenSplit(path),
    },
    { label: "关闭分屏", disabled: !d.splitPath, onSelect: d.onCloseSplit },
    {
      label: isReviewed(path) ? "取消已审" : "标记为已审",
      separator: true,
      disabled: virtual,
      onSelect: () => {
        void markReviewed(path, !isReviewed(path))
          .catch((e) => toast(String(e) || "标记失败，请到版本控制面操作", "error"));
      },
    },
    ...svnCodeMenuItems(path, virtual ? undefined : d.svnFiles.get(pathKey(path))),
    { label: "在文件树中显示", disabled: virtual, onSelect: () => revealInTree(path) },
    { label: "复制路径", separator: true, disabled: virtual, onSelect: () => d.copy(path) },
    { label: "复制相对路径", disabled: virtual, onSelect: () => d.copy(relativeTo(d.root, path)) },
  ];
}
