import { setSession, useWorkspaceSelector, type Updater } from "../lib/workspaceSession";

/**
 * 分屏会话：右侧编辑器显示哪个文件。
 *
 * 分屏不持有自己的 model——文件必须先是标签（`openFile` 会打开它），
 * 关标签 / 改名 / 删除时由 `useFileSession` 顺手清掉这个指针。
 */
export function useSplitView(openFile: (path: string) => Promise<boolean>) {
  const splitPath = useWorkspaceSelector((s) => s.splitPath);
  const setSplitPath = (v: Updater<string | null>) => setSession({ splitPath: v });

  const openSplit = async (path: string) => {
    if (!(await openFile(path))) return;
    setSplitPath(path);
  };

  return { splitPath, setSplitPath, openSplit, closeSplit: () => setSplitPath(null) };
}
