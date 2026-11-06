import { closeModel, renameModel } from "../lib/editorStore";
import { getSession, setSession } from "../lib/workspaceSession";
import { coversPath, pickClosable, renameTabs } from "../lib/tabSession";
import { remapPath } from "../lib/workspace";
import { rememberClosed } from "../lib/closedTabs";

/** File removal owns model disposal; closing only one of two views never calls this path. */
export function useFileTabLifecycle() {
  const closeTab = (path: string, confirmed = false) => {
    const { tabs, conflictPath } = getSession(), tab = tabs.find(t => t.path === path);
    if (!tab) return;
    if ((tab.dirty || tab.eolChanged) && !confirmed) { setSession({ closingPath: path }); return; }
    closeModel(path); rememberClosed(path);
    setSession({ tabs: tabs.filter(t => t.path !== path), conflictPath: conflictPath === path ? null : conflictPath });
  };
  const closeMany = (want: Parameters<typeof pickClosable>[1]): number => {
    const { tabs, conflictPath } = getSession(), { close, kept } = pickClosable(tabs, want);
    if (!close.length) return kept;
    close.forEach(path => { closeModel(path); rememberClosed(path); });
    setSession({ tabs: tabs.filter(t => !close.includes(t.path)), conflictPath: conflictPath && close.includes(conflictPath) ? null : conflictPath });
    return kept;
  };
  const handleRenamed = (oldPath: string, newPath: string) => {
    const { tabs, editorGroups, conflictPath } = getSession(), remap = (path: string) => remapPath(path, oldPath, newPath);
    const affected = tabs.filter(t => coversPath(t.path, oldPath));
    if (!affected.length) return;
    affected.forEach(t => renameModel(t.path, remap(t.path)));
    setSession({ tabs: renameTabs(tabs, oldPath, newPath), conflictPath: conflictPath ? remap(conflictPath) : null,
      editorGroups: editorGroups && { ...editorGroups, left: editorGroups.left.map(remap), right: editorGroups.right.map(remap), leftActive: editorGroups.leftActive ? remap(editorGroups.leftActive) : null, rightActive: editorGroups.rightActive ? remap(editorGroups.rightActive) : null, recent: editorGroups.recent.map(remap) } });
  };
  const handleDeleted = (paths: string[]) => {
    const { tabs, conflictPath } = getSession(), gone = (path: string) => paths.some(base => coversPath(path, base));
    tabs.filter(t => gone(t.path)).forEach(t => closeModel(t.path));
    setSession({ tabs: tabs.filter(t => !gone(t.path)), conflictPath: conflictPath && gone(conflictPath) ? null : conflictPath });
  };
  return { closeTab, closeMany, handleRenamed, handleDeleted };
}
