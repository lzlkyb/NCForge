import { useEffect, useMemo, useRef } from "react";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { SvnFileRows } from "./SvnFileRows";
import { keyOf, reviewProgress, type ChangeItem, type ChangesView } from "../../lib/svn";
import { SVN_FILTERS, svnFilterCounts, svnVisibleGroups } from "../../lib/svnList";
import { setSvnListPrefs, useSvnListPrefs } from "../../lib/svnListPrefs";
import { clearSvnPicked, isSvnCommittable, selectSvnPaths } from "../../lib/svnDraft";

export function ChangeList({ view, reviewed, selected, loading, error, onSelect, showIgnored, onToggleIgnored, root = "", picked = new Set<string>(), busy = false, onOpenFile }: { view: ChangesView; reviewed: Set<string>; selected: string | null; loading: boolean; error: string | null; onSelect: (item: ChangeItem) => void; showIgnored: boolean; onToggleIgnored: () => void; root?: string; picked?: ReadonlySet<string>; busy?: boolean; onOpenFile?: (path: string) => void }) {
  const prefs = useSvnListPrefs(root), list = useRef<HTMLDivElement>(null);
  const initialScroll = useRef(prefs.scroll);
  const groups = useMemo(() => svnVisibleGroups(view,prefs.filter,prefs.search,prefs.sort,showIgnored,reviewed,picked),[view,prefs,showIgnored,reviewed,picked]);
  // 筛选片计数一趟算完并记住：输入搜索词、滚动等无关渲染不再把几千行过 7 遍
  const counts = useMemo(() => svnFilterCounts(view.groups.flatMap(g => g.items).filter(it => showIgnored || !it.ignored),reviewed,picked),[view,showIgnored,reviewed,picked]);
  const progress = reviewProgress({ ...view, groups: view.groups.map(g => ({ ...g, items: g.items.filter(it => !it.ignored) })) },reviewed);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = initialScroll.current; return () => { if (el) setSvnListPrefs(root,{scroll:el.scrollTop}); }; },[root]); // 滚动只在离开时落盘，避免每个滚动帧写本地存储。
  return <aside className="vc-chg">
    <div className="vc-chg-top">
      <div className="vc-list-title"><b>本地改动 · {view.shown}</b>
        <Menu portal width="w-56" trigger={(open,toggle)=><button type="button" className="vc-btn vc-btn-sm" aria-label="筛选与清单操作" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="settings" size={13}/></button>}>
          {close=><>
            {(Object.keys(SVN_FILTERS) as (keyof typeof SVN_FILTERS)[]).map(f=><MenuItem key={f} label={`${SVN_FILTERS[f]} ${counts[f]}`} checked={prefs.filter===f} onClick={()=>{setSvnListPrefs(root,{filter:f});close();}}/>)}
            <MenuItem label="按文件路径排序" checked={prefs.sort==="path"} onClick={()=>{setSvnListPrefs(root,{sort:"path"});close();}}/>
            <MenuItem label="按最近改动排序" checked={prefs.sort==="mtime"} onClick={()=>{setSvnListPrefs(root,{sort:"mtime"});close();}}/>
            <MenuItem label="只选已审" disabled={busy} onClick={()=>{selectSvnPaths(root,view.groups.flatMap(g=>g.items).filter(it=>isSvnCommittable(it)&&reviewed.has(keyOf(it.path))).map(it=>it.path));close();}}/>
            <MenuItem label="清空选择" disabled={busy || !picked.size} onClick={()=>{clearSvnPicked(root);close();}}/>
            <MenuItem label={`显示构建产物 ${view.ignored}`} checked={showIgnored} onClick={()=>{onToggleIgnored();close();}}/>
          </>}
        </Menu>
      </div>
      <div className="vc-search" data-focus-container>
        <Icon name="search" size={13} /><input aria-label="筛选版本控制文件" value={prefs.search} onChange={e => setSvnListPrefs(root,{search:e.target.value})} placeholder="搜索文件、路径或模块" spellCheck={false} />
        {prefs.search && <button type="button" aria-label="清除文件筛选" onClick={() => setSvnListPrefs(root,{search:""})}><Icon name="close" size={12} /></button>}
      </div>
      <div className="vc-chips" aria-label="改动筛选">
        {(["all","unreviewed","picked",...(counts.conflict ? ["conflict"] : []),...(!["all","unreviewed","picked","conflict"].includes(prefs.filter) ? [prefs.filter] : [])] as (keyof typeof SVN_FILTERS)[]).map(f => <button key={f} type="button" className="vc-chip" aria-pressed={prefs.filter === f} data-on={prefs.filter === f || undefined} onClick={() => setSvnListPrefs(root,{filter:f})}>{SVN_FILTERS[f]}<span className="n">{counts[f]}</span></button>)}
      </div>
    </div>
    <div className="vc-list" ref={list}>
      {loading && !view.total && <div className="vc-empty" role="status"><Icon name="spinner" size={20} className="animate-spin" /><div>正在扫描工作副本…<br />完成后显示真实改动</div></div>}
      {error && !loading && <div className="vc-alert" data-tone="warn"><Icon name="alert" size={14} /><span>{view.total ? "扫描失败，以下是上次结果。" : "尚未取得改动结果。"}请在上方重试。</span></div>}
      {!error && !groups.length && !(loading && !view.total) && <div className="vc-empty"><Icon name="check" size={24} /><div>{!view.total ? "工作副本没有本地改动" : !view.shown && view.ignored ? "只有构建产物，没有源码改动" : "当前筛选没有匹配文件"}</div>{view.total > 0 && <button type="button" className="vc-btn" onClick={() => setSvnListPrefs(root,{search:"",filter:"all"})}>清除筛选</button>}</div>}
      {groups.map(group => <SvnFileRows key={group.module} group={group} closed={prefs.closed.includes(group.module)} onToggleGroup={() => setSvnListPrefs(root,{closed:prefs.closed.includes(group.module) ? prefs.closed.filter(s => s !== group.module) : [...prefs.closed,group.module]})} selected={selected} reviewed={reviewed} picked={picked} root={root} busy={busy} sort={prefs.sort} onSelect={onSelect} onOpenFile={onOpenFile} />)}
    </div>
    <div className="vc-chg-foot">
      <div className="vc-list-summary"><button type="button" className="vc-chip" onClick={()=>setSvnListPrefs(root,{filter:"reviewed"})}>已审 {progress.done}/{progress.total}</button><button type="button" className="vc-chip" onClick={() => setSvnListPrefs(root,{filter:"picked",search:""})}>已选 {picked.size}</button></div>
    </div>
  </aside>;
}
