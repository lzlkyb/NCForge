import { closeModel, renameModel } from "../lib/editorStore";
import { getSession, setSession } from "../lib/workspaceSession";
import { coversPath, pickClosable, renameTabs } from "../lib/tabSession";
import { remapPath } from "../lib/workspace";
import { rememberClosed } from "../lib/closedTabs";
import { isHistoryRestoring } from "../lib/historyRestoreGuard";

/**
 * File removal owns model disposal; closing only one of two views never calls this path.
 *
 * 🔴 两条「未决决策」提示（`conflictPath` / `encodingIssue`）都必须跟着标签走：它们存在
 * 会话仓库里（切页不消失），只清 conflictPath 会留下上一轮的红色编码横幅——重开同名
 * 文件时用户以为这次又没存上。改名走 remap（提示要留住），关闭/删除走清空。
 */
export function useFileTabLifecycle() {
  const closeTab = (path: string, confirmed = false) => {
    if (isHistoryRestoring(path)) return;
    const { tabs, conflictPath, encodingIssue } = getSession(), tab = tabs.find(t => t.path === path);
    if (!tab) return;
    if ((tab.dirty || tab.eolChanged) && !confirmed) { setSession({ closingPath: path }); return; }
    closeModel(path); rememberClosed(path);
    setSession({ tabs: tabs.filter(t => t.path !== path), conflictPath: conflictPath === path ? null : conflictPath,
      encodingIssue: encodingIssue?.path === path ? null : encodingIssue });
  };
  const closeMany = (want: Parameters<typeof pickClosable>[1]): number => {
    const { tabs, conflictPath, encodingIssue } = getSession(), picked = pickClosable(tabs, want);
    const close = picked.close.filter(path => !isHistoryRestoring(path)), kept = picked.kept + picked.close.length - close.length;
    if (!close.length) return kept;
    close.forEach(path => { closeModel(path); rememberClosed(path); });
    setSession({ tabs: tabs.filter(t => !close.includes(t.path)), conflictPath: conflictPath && close.includes(conflictPath) ? null : conflictPath,
      encodingIssue: encodingIssue && close.includes(encodingIssue.path) ? null : encodingIssue });
    return kept;
  };
  const handleRenamed = (oldPath: string, newPath: string) => {
    const { tabs, editorGroups, conflictPath, encodingIssue } = getSession(), remap = (path: string) => remapPath(path, oldPath, newPath);
    const affected = tabs.filter(t => coversPath(t.path, oldPath));
    if (!affected.length) return;
    affected.forEach(t => renameModel(t.path, remap(t.path)));
    setSession({ tabs: renameTabs(tabs, oldPath, newPath), conflictPath: conflictPath ? remap(conflictPath) : null,
      encodingIssue: encodingIssue ? { ...encodingIssue, path: remap(encodingIssue.path) } : null,
      editorGroups: editorGroups && { ...editorGroups, left: editorGroups.left.map(remap), right: editorGroups.right.map(remap), leftActive: editorGroups.leftActive ? remap(editorGroups.leftActive) : null, rightActive: editorGroups.rightActive ? remap(editorGroups.rightActive) : null, recent: editorGroups.recent.map(remap) } });
  };
  const handleDeleted = (paths: string[]) => {
    const { tabs, conflictPath, encodingIssue } = getSession(), gone = (path: string) => paths.some(base => coversPath(path, base));
    tabs.filter(t => gone(t.path)).forEach(t => closeModel(t.path));
    setSession({ tabs: tabs.filter(t => !gone(t.path)), conflictPath: conflictPath && gone(conflictPath) ? null : conflictPath,
      encodingIssue: encodingIssue && gone(encodingIssue.path) ? null : encodingIssue });
  };
  return { closeTab, closeMany, handleRenamed, handleDeleted };
}
