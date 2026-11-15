import { MenuItem } from "../ui/Menu";
import { LayoutMenu } from "../layout/HeaderMenus";
import { TaskMenu } from "./TaskMenu";
import { getSession, setSession, useWorkspaceSelector } from "../../lib/workspaceSession";
import { emptyEditorGroups, swapEditorGroups, type EditorGroupId } from "../../lib/editorGroups";
import { swapGroupNavigation } from "../../lib/navHistory";
import { tabKeyLabel } from "../../lib/keymap";
import { swapGroupMru } from "../../lib/tabMru";
import { moduleOf } from "../../lib/ncModule";
import { dirName } from "../../lib/workspace";
import { setEditorPrefs, useEditorPrefs } from "../../lib/editorPrefs";

export function EditorGroupTools({ root, session, compiling, canCompile, onCompile, reading }: {
  root: string; session: { openSplit: (path: string) => Promise<void>; closeSplit: () => void; selectTab: (path: string) => void };
  compiling: boolean; canCompile: boolean; onCompile: () => void;
  reading?: { pinned: boolean; heavy?: boolean; onTogglePinned: () => void };
}) {
  const groups = useWorkspaceSelector(s => s.editorGroups), split = !!groups?.right.length;
  const activePath = useWorkspaceSelector(s => s.activePath);
  const { minimap } = useEditorPrefs();
  const canOutline = !!activePath && !activePath.includes("://") && /\.(java|rest|upm)$/i.test(activePath);
  const module = activePath ? moduleOf(root, dirName(activePath)) : null;
  const reason = !root ? "请先打开工程" : !canCompile ? "请先打开可编辑的工程文件" : !module ? "当前文件不属于工作区模块" : null;
  const focus = (group: EditorGroupId) => { setSession({ editorGroups: old => ({ ...(old ?? emptyEditorGroups()), focused: group }) }); const path = getSession().activePath; if (path) session.selectTab(path); };
  return <div className="wb-editor-tools" aria-label="代码执行与分组工具">
    {split ? <div className="wb-group-switch" role="group" aria-label="活动编辑器组">
      {([['left', '左组'], ['right', '右组']] as const).map(([id, name]) => <button key={id} type="button" disabled={!groups?.[id].length} aria-pressed={groups?.focused === id} title={`聚焦${name} · ${tabKeyLabel(id)}`} onClick={() => focus(id)}>{name}</button>)}
    </div> : <span className="wb-editor-tools-label">代码</span>}
    <span className="wb-editor-tools-spacer" />
    <TaskMenu root={root} compiling={compiling} compile={{ module, reason, run: onCompile }} />
    <LayoutMenu editorActions={close => <>
        {split && <>
          <MenuItem label="聚焦左编辑器组" disabled={!groups?.left.length} active={groups?.focused === "left"} onClick={() => { close(); focus("left"); }} />
          <MenuItem label="聚焦右编辑器组" disabled={!groups?.right.length} active={groups?.focused === "right"} onClick={() => { close(); focus("right"); }} />
          <div className="wb-menu-separator" role="separator" />
        </>}
        <MenuItem label="在右组打开当前文件" disabled={!getSession().activePath} onClick={() => { close(); const path = getSession().activePath; if (path) void session.openSplit(path); }} />
        <MenuItem label="交换左右编辑器组" disabled={!split} onClick={() => { close(); swapGroupNavigation(); swapGroupMru(); setSession({ tabs: tabs => tabs.map(tab => tab.previewGroup ? { ...tab, previewGroup: tab.previewGroup === "left" ? "right" : "left" } : tab), editorGroups: old => swapEditorGroups(old ?? emptyEditorGroups()) }); }} />
        <MenuItem label="恢复等宽比例" disabled={!split} onClick={() => { close(); setSession({ editorGroups: old => ({ ...(old ?? emptyEditorGroups()), ratio: .5 }) }); }} />
        <MenuItem label="合并到左组" hint="文件和未保存修改保留" disabled={!split} onClick={() => { close(); session.closeSplit(); }} />
      </>} readingActions={close => <>
        <MenuItem label="小地图" checked={minimap && !reading?.heavy} disabled={reading?.heavy} hint={reading?.heavy ? "大文件已暂停小地图" : undefined} onClick={() => { close(); setEditorPrefs({ minimap: !minimap }); }} />
        {reading && <MenuItem label="固定文件结构" checked={reading.pinned} disabled={!canOutline} onClick={() => { close(); reading.onTogglePinned(); }} />}
      </>} />
  </div>;
}
