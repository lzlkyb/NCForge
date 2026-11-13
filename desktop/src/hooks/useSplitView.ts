import { useRef } from "react";
import { setSession, useWorkspaceSelector, type Updater } from "../lib/workspaceSession";
import { closeRightGroup, emptyEditorGroups, selectGroupFile } from "../lib/editorGroups";
import { getSession } from "../lib/workspaceSession";
import { pinTab } from "../lib/tabSession";
import { workspaceEpoch } from "../lib/workspaceEpoch";
import { mergeGroupNavigation } from "../lib/navHistory";
import { mergeGroupMru } from "../lib/tabMru";
import { filePathKey } from "../lib/workspace";

/**
 * 分屏会话：右侧编辑器显示哪个文件。
 *
 * 分屏不持有自己的 model——文件必须先是标签（`openFile` 会打开它），
 * 关标签 / 改名 / 删除时由 `useFileSession` 顺手清掉这个指针。
 */
export function useSplitView(openFile: (path: string) => Promise<boolean>) {
  const splitPath = useWorkspaceSelector((s) => s.splitPath);
  const setSplitPath = (v: Updater<string | null>) => setSession({ splitPath: v });
  /** 右侧最近一次「在右侧打开」的号。 */
  const seq = useRef(0);

  const openSplit = async (path: string) => {
    const root = getSession().root, epoch = workspaceEpoch();
    // 连点两个「在右侧打开」时右侧要落在**后点的那一个**。打开是异步的：先点的那个
    // 读得慢一点就会在后点的之后回来，把右侧抢回上一个文件。按点击顺序抢号。
    const nonce = ++seq.current;
    if (!(await openFile(path))) return;
    if (nonce !== seq.current || root !== getSession().root || epoch !== workspaceEpoch()) return;
    const canonical = getSession().tabs.find(t => filePathKey(t.path) === filePathKey(path))?.path;
    if (!canonical) return;
    setSession({ tabs: tabs => pinTab(tabs, canonical), editorGroups: groups => selectGroupFile(groups ?? emptyEditorGroups(), "right", canonical) });
  };

  return { splitPath, setSplitPath, openSplit, closeSplit: () => {
    mergeGroupNavigation("left", getSession().editorGroups?.focused === "right");
    mergeGroupMru(getSession().editorGroups?.focused ?? "left");
    setSession({ tabs: tabs => tabs.map(tab => tab.preview && getSession().editorGroups?.right.includes(tab.path) ? { ...tab, preview: false } : tab), editorGroups: groups => closeRightGroup(groups ?? emptyEditorGroups()) });
  } };
}
