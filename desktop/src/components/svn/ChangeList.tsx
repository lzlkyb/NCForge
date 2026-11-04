import { useEffect, useMemo, useRef } from "react";
import { Icon } from "../ui/icon";
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
      <div className="vc-list-title"><b>本地改动</b><span>{view.shown} 个</span></div>
      <div className="vc-search" data-focus-container>
        <Icon name="search" size={13} /><input aria-label="筛选版本控制文件" value={prefs.search} onChange={e => setSvnListPrefs(root,{search:e.target.value})} placeholder="搜索文件、路径或模块" spellCheck={false} />
        {prefs.search && <button type="button" aria-label="清除文件筛选" onClick={() => setSvnListPrefs(root,{search:""})}><Icon name="close" size={12} /></button>}
      </div>
      <div className="vc-chips" aria-label="改动筛选">
        {(Object.keys(SVN_FILTERS) as (keyof typeof SVN_FILTERS)[]).map(f => <button key={f} type="button" className="vc-chip" aria-pressed={prefs.filter === f} data-on={prefs.filter === f || undefined} onClick={() => setSvnListPrefs(root,{filter:f})}>{SVN_FILTERS[f]}<span className="n">{counts[f]}</span></button>)}
      </div>
      <div className="vc-list-options"><label>排序 <select aria-label="改动排序" value={prefs.sort} onChange={e => setSvnListPrefs(root,{sort:e.target.value === "mtime" ? "mtime" : "path"})}><option value="path">文件路径</option><option value="mtime">最近改动</option></select></label><button type="button" className="vc-chip" disabled={busy} onClick={() => selectSvnPaths(root,view.groups.flatMap(g => g.items).filter(it => isSvnCommittable(it) && reviewed.has(keyOf(it.path))).map(it => it.path))}>只选已审</button></div>
    </div>
    <div className="vc-list" ref={list}>
      {loading && !view.total && <div className="vc-empty" role="status"><Icon name="spinner" size={20} className="animate-spin" /><div>正在扫描工作副本…<br />完成后显示真实改动</div></div>}
      {error && !loading && <div className="vc-alert" data-tone="warn"><Icon name="alert" size={14} /><span>{view.total ? "扫描失败，以下是上次结果。" : "尚未取得改动结果。"}请在上方重试。</span></div>}
      {!error && !groups.length && !(loading && !view.total) && <div className="vc-empty"><Icon name="check" size={24} /><div>{!view.total ? "工作副本没有本地改动" : !view.shown && view.ignored ? "只有构建产物，没有源码改动" : "当前筛选没有匹配文件"}</div>{view.total > 0 && <button type="button" className="vc-btn" onClick={() => setSvnListPrefs(root,{search:"",filter:"all"})}>清除筛选</button>}</div>}
      {groups.map(group => <SvnFileRows key={group.module} group={group} closed={prefs.closed.includes(group.module)} onToggleGroup={() => setSvnListPrefs(root,{closed:prefs.closed.includes(group.module) ? prefs.closed.filter(s => s !== group.module) : [...prefs.closed,group.module]})} selected={selected} reviewed={reviewed} picked={picked} root={root} busy={busy} sort={prefs.sort} onSelect={onSelect} onOpenFile={onOpenFile} />)}
    </div>
    <div className="vc-chg-foot">
      <div className="vc-list-summary"><span>已审 {progress.done} / {progress.total}</span><span>本次已选 <b>{picked.size}</b></span></div>
      <progress className="vc-review-progress" value={progress.done} max={progress.total || 1} aria-label="文件审查进度" />
      <div className="vc-list-summary"><button type="button" className="vc-chip" onClick={() => setSvnListPrefs(root,{filter:"picked",search:""})}>查看已选</button><button type="button" className="vc-chip" disabled={busy || !picked.size} onClick={() => clearSvnPicked(root)}>清空选择</button></div>
      <button type="button" className="vc-chip" aria-pressed={showIgnored} onClick={onToggleIgnored}>{showIgnored ? "隐藏构建产物" : `显示 ${view.ignored} 条构建产物`}</button>
    </div>
  </aside>;
}
