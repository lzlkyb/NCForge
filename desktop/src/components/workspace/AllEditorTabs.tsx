import { useMemo, useState } from "react";
import { Menu, MenuItem } from "../ui/Menu";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { tabPathLabels } from "../../lib/tabPathLabels";
import { useWorkspaceSelector, type TabMeta } from "../../lib/workspaceSession";

export function AllEditorTabs({ root, tabs, activePath, onSelect }: { root: string; tabs: TabMeta[]; activePath: string | null; onSelect: (path: string) => void }) {
  const [query, setQuery] = useState(""), [dirtyOnly, setDirtyOnly] = useState(false), [recentFirst, setRecentFirst] = useState(false);
  const recent = useWorkspaceSelector(s => s.editorGroups?.recent);
  const labels = tabPathLabels(root, tabs);
  const shown = useMemo(() => {
    const found = tabs.filter(t => (!dirtyOnly || t.dirty || t.eolChanged) && `${t.name} ${t.path}`.toLowerCase().includes(query.trim().toLowerCase()));
    const rank = (path: string) => { const index = recent?.indexOf(path) ?? -1; return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    return recentFirst ? found.sort((a, b) => rank(a.path) - rank(b.path)) : found;
  }, [tabs, query, dirtyOnly, recentFirst, recent]);
  return <div className="wb-tabs-all-wrap"><Menu portal width="w-80" trigger={(open, toggle) => <button type="button" className="wb-icon-btn" aria-label="所有标签" aria-haspopup="menu" aria-expanded={open} title="所有标签：搜索、最近使用与未保存筛选" disabled={!tabs.length} onClick={toggle}><WorkspaceGlyph name="down" size={14} /></button>}>
    {close => <>
      <div className="wb-tabs-filter">
        <input autoFocus aria-label="搜索打开的文件" value={query} onChange={event => setQuery(event.target.value)} placeholder="文件名或路径" />
        <div className="wb-tabs-filter-options"><button type="button" aria-pressed={recentFirst} onClick={() => setRecentFirst(value => !value)}>最近使用</button><button type="button" aria-pressed={dirtyOnly} onClick={() => setDirtyOnly(value => !value)}>仅未保存</button><span>{shown.length} / {tabs.length}</span></div>
      </div>
      {shown.length ? shown.map(tab => <MenuItem key={tab.path} label={<span className="wb-tabs-menu-label"><span className="wb-tabs-menu-name">{tab.name}</span><span className="wb-tabs-menu-detail">{[labels.get(tab.path), tab.pinned ? "已钉住" : tab.preview ? "预览" : "", tab.readOnly ? "只读" : ""].filter(Boolean).join(" · ")}</span></span>}
        active={tab.path === activePath} trailing={tab.dirty || tab.eolChanged ? <span className="wb-dirty-dot" /> : undefined} onClick={() => { onSelect(tab.path); close(); }} />) : <div className="wb-tabs-filter-empty">没有匹配文件，请调整筛选。</div>}
    </>}
  </Menu></div>;
}
