import { Menu, MenuItem } from "../ui/Menu";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { TaskMenu } from "./TaskMenu";
import { getSession, setSession, useWorkspaceSelector } from "../../lib/workspaceSession";
import { emptyEditorGroups, swapEditorGroups, type EditorGroupId } from "../../lib/editorGroups";
import { swapGroupNavigation } from "../../lib/navHistory";
import { tabKeyLabel } from "../../lib/keymap";
import { swapGroupMru } from "../../lib/tabMru";

export function EditorGroupTools({ root, session, compiling, canCompile, onCompile }: {
  root: string; session: { openSplit: (path: string) => Promise<void>; closeSplit: () => void; selectTab: (path: string) => void };
  compiling: boolean; canCompile: boolean; onCompile: () => void;
}) {
  const groups = useWorkspaceSelector(s => s.editorGroups), split = !!groups?.right.length;
  const focus = (group: EditorGroupId) => { setSession({ editorGroups: old => ({ ...(old ?? emptyEditorGroups()), focused: group }) }); const path = getSession().activePath; if (path) session.selectTab(path); };
  return <div className="wb-editor-tools" aria-label="代码执行与分组工具">
    {split ? <div className="wb-group-switch" aria-label="活动编辑器组">
      {([['left', '左组'], ['right', '右组']] as const).map(([id, name]) => <button key={id} type="button" disabled={!groups?.[id].length} aria-pressed={groups?.focused === id} title={`聚焦${name} · ${tabKeyLabel(id)}`} onClick={() => focus(id)}>{name}</button>)}
    </div> : <span className="wb-editor-tools-label">代码</span>}
    <span className="wb-editor-tools-spacer" />
    <Menu portal width="w-64" trigger={(open, toggle) => <button type="button" className="wb-outline-btn" aria-label="编辑器组操作" aria-expanded={open} aria-haspopup="menu" onClick={toggle}><Icon name="panel" size={13} />分组</button>}>
      {close => <>
        <MenuItem label="在右组打开当前文件" disabled={!getSession().activePath} onClick={() => { close(); const path = getSession().activePath; if (path) void session.openSplit(path); }} />
        <MenuItem label="交换左右编辑器组" disabled={!split} onClick={() => { close(); swapGroupNavigation(); swapGroupMru(); setSession({ tabs: tabs => tabs.map(tab => tab.previewGroup ? { ...tab, previewGroup: tab.previewGroup === "left" ? "right" : "left" } : tab), editorGroups: old => swapEditorGroups(old ?? emptyEditorGroups()) }); }} />
        <MenuItem label="恢复等宽比例" disabled={!split} onClick={() => { close(); setSession({ editorGroups: old => ({ ...(old ?? emptyEditorGroups()), ratio: .5 }) }); }} />
        <MenuItem label="合并到左组" hint="文件和未保存修改保留" disabled={!split} onClick={() => { close(); session.closeSplit(); }} />
      </>}
    </Menu>
    <TaskMenu root={root} compiling={compiling} />
    <Button size="sm" variant="outline" className="wb-compile-btn" disabled={!canCompile || compiling} isLoading={compiling} loadingText="编译中" onClick={onCompile} title="编译活动编辑器组文件所属模块"><Icon name="play" size={12} />{compiling ? "编译中…" : "编译"}</Button>
  </div>;
}
