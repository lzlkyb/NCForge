import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceRoot } from "../../lib/workspaceSession";
import { workspaceEpoch } from "../../lib/workspaceEpoch";
import { filterHistory, svnHistory, svnRevisionDiff, type HistoryEntry } from "../../lib/svnHistory";
import { friendlySvnError, formatRevTime } from "../../lib/svn";
import { Icon } from "../ui/icon";
import { SvnDiffEditor } from "./SvnDiffEditor";
import { svnDiffLanguage } from "./DiffPane";
import { toast } from "../ui/toast";
import { Menu } from "../ui/Menu";
import "../../svn-history.css";
const PAGE = 30;
const initial = { entries: [] as HistoryEntry[], loading: false, done: false, error: null as string | null };

export function HistoryView({ path, title, modulePath, initialRevision, onBack }: { path: string; title: string; modulePath?: string; initialRevision?: number; onBack: () => void }) {
  const root = useWorkspaceRoot(); const epoch = workspaceEpoch();
  const [filters, setFilters] = useState({ scope: "file", keyword: "", author: "", since: "", until: "" });
  const [result, setResult] = useState(initial);
  const [revision, setRevision] = useState<number | null>(initialRevision ?? null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const requests = useRef({ sequence: 0, loading: false, cursor: 0 });
  const source = filters.scope === "root" ? root ?? path : filters.scope === "module" ? modulePath ?? root ?? path : path;
  const load = useCallback(async (reset: boolean) => {
    if (!root || epoch !== workspaceEpoch()) return;
    if (!reset && requests.current.loading) return;
    const sequence = ++requests.current.sequence; requests.current.loading = true;
    setResult(prev => ({ ...(reset ? initial : prev), loading: true, error: null }));
    try {
      const page = await svnHistory(source, PAGE, reset ? initialRevision ? initialRevision + 1 : 0 : requests.current.cursor);
      if (sequence !== requests.current.sequence) return;
      if (page.entries.length) requests.current.cursor = page.entries[page.entries.length - 1].revision;
      setResult(prev => ({ entries: [...new Map([...(reset ? [] : prev.entries), ...page.entries].map(entry => [entry.revision, entry])).values()], loading: false, done: page.entries.length < PAGE, error: null }));
      if (reset) { const chosen = page.entries.find(entry => entry.revision === initialRevision); setRevision(chosen?.revision ?? null); setSelectedPath(chosen?.paths[0]?.path ?? null); }
    } catch (error) { if (sequence === requests.current.sequence) setResult(prev => ({ ...prev, loading: false, error: friendlySvnError(error) })); }
    finally { if (sequence === requests.current.sequence) requests.current.loading = false; }
  }, [source, root, epoch, initialRevision]);
  useEffect(() => { const state = requests.current; state.cursor = 0; void load(true); return () => { state.sequence++; state.loading = false; }; }, [load]);
  const entries = filterHistory(result.entries, filters.keyword, filters.author, filters.since, filters.until);
  const selected = result.entries.find(entry => entry.revision === revision);
  const diff = useQuery({ queryKey: ["svn-revision-diff", root, epoch, revision, selectedPath], queryFn: () => svnRevisionDiff(selectedPath!, revision!), enabled: !!selectedPath && !!revision, retry: false });
  const patchFilter = (patch: Partial<typeof filters>) => setFilters(prev => ({ ...prev, ...patch }));
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast("已复制", "success"); } catch { toast("复制失败", "error"); } };
  return <section className="vc-main vc-history">
    <div className="vc-bar"><Icon name="history" size={14} /><b>提交历史</b><span className="vc-path" title={source}>{title}</span><span className="vc-sp" /><button className="vc-btn" onClick={onBack}>返回审查</button><button className="vc-btn" disabled={result.loading} onClick={() => void load(true)}><Icon name="refresh" size={12} className={result.loading ? "animate-spin" : undefined} />刷新</button></div>
    <div className="vc-history-filters">
      <select aria-label="历史范围" value={filters.scope} onChange={event => patchFilter({ scope: event.target.value })}><option value="file">当前路径</option>{modulePath && <option value="module">当前模块</option>}<option value="root">工作副本</option></select>
      <input aria-label="筛选已加载历史" placeholder="说明、版本或路径" value={filters.keyword} onChange={event => patchFilter({ keyword: event.target.value })} />
      <Menu portal width="w-72" trigger={(open,toggle)=><button type="button" className="vc-btn vc-btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>更多筛选{(filters.author || filters.since || filters.until) ? " · 已设置" : ""}</button>}>
        {()=><div className="vc-history-filter-options"><label>作者<select aria-label="历史作者" value={filters.author} onChange={event => patchFilter({ author: event.target.value })}><option value="">所有作者</option>{[...new Set(result.entries.map(entry => entry.author))].map(author => <option key={author} value={author}>{author || "无作者"}</option>)}</select></label>
        <label>开始日期<input type="date" aria-label="历史开始日期" value={filters.since} onChange={event => patchFilter({ since: event.target.value })} /></label><label>结束日期<input type="date" aria-label="历史结束日期" value={filters.until} onChange={event => patchFilter({ until: event.target.value })} /></label></div>}
      </Menu>
      <span className="vc-hint">筛选已加载 {result.entries.length} 条，匹配 {entries.length} 条</span>
    </div>
    {result.error && <div className="vc-alert" data-tone="warn"><span>{result.error}</span><button className="vc-btn" disabled={result.loading} onClick={() => void load(result.entries.length === 0)}>重试</button></div>}
    <div className="vc-history-layout">
      <div className="vc-history-records" aria-label="提交记录">
        {result.loading && !result.entries.length && <div className="vc-empty"><Icon name="spinner" className="animate-spin" /><span>正在读取提交记录…</span></div>}
        {!result.loading && !result.error && !entries.length && <div className="vc-empty">{result.entries.length ? "当前筛选没有匹配记录" : "这个路径没有提交记录"}</div>}
        {entries.map(entry => <button type="button" className="vc-history-record" data-on={revision === entry.revision || undefined} key={entry.revision} onClick={() => { setRevision(entry.revision); setSelectedPath(entry.paths[0]?.path ?? null); }}><span className="vc-log-hd"><b className="vc-log-rev">r{entry.revision}</b><span>{entry.author || "无作者"}</span><span className="vc-hint">{formatRevTime(entry.date)}</span></span><span className="vc-log-msg">{entry.message.split("\n")[0] || "无提交说明"}</span><span className="vc-hint">{entry.paths.length} 个改动路径</span></button>)}
        {!!result.entries.length && !result.done && <button className="vc-btn vc-history-more" disabled={result.loading} onClick={() => void load(false)}>{result.loading ? "加载中…" : "加载更早的提交"}</button>}
        {result.done && !!result.entries.length && <p className="vc-hint vc-history-more">已到当前路径最早记录</p>}
      </div>
      <div className="vc-history-detail">
        {!selected && <div className="vc-empty">选择一条提交查看实际改动路径和版本差异</div>}
        {selected && <><div className="vc-history-contextbar"><b>r{selected.revision}</b><select aria-label="历史改动路径" value={selectedPath ?? ""} onChange={e=>setSelectedPath(e.target.value)}>{selected.paths.map(change=><option key={change.path} value={change.path}>{change.action} · {change.path}</option>)}</select>
          <Menu portal width="w-96" trigger={(open,toggle)=><button type="button" className="vc-btn vc-btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>提交详情 · {selected.paths.length} 路径</button>}>
          {()=><><div className="vc-history-summary"><b>r{selected.revision} · {selected.author || "无作者"}</b><button className="vc-btn" onClick={() => void copy(`r${selected.revision}`)}>复制版本号</button><p>{selected.message || "无提交说明"}</p></div>
          <div className="vc-history-paths">{selected.paths.map(change => <div className="vc-history-path" key={change.path}><button className="vc-btn" data-on={selectedPath === change.path || undefined} title={change.path} onClick={() => setSelectedPath(change.path)}><b>{change.action}</b><span>{change.path}</span></button><button className="vc-btn" aria-label={`复制路径 ${change.path}`} onClick={() => void copy(change.path)}><Icon name="copy" size={12} /></button>{change.copyFromPath && <span className="vc-hint">来自 {change.copyFromPath} @ r{change.copyFromRevision}</span>}</div>)}</div>
          </>}
          </Menu></div>
          {diff.isFetching && <div className="vc-empty"><Icon name="spinner" className="animate-spin" />正在读取指定版本正文…</div>}
          {!diff.isFetching && diff.error && <div className="vc-alert" data-tone="warn"><span>{friendlySvnError(diff.error)}</span><button className="vc-btn" onClick={() => void diff.refetch()}>重试</button></div>}
          {!diff.isFetching && diff.data && <SvnDiffEditor original={diff.data.beforeText} modified={diff.data.afterText} sourceKey={`history:${root}:${epoch}:${revision}:${selectedPath}`} root={root} language={svnDiffLanguage(diff.data.path)} originalLabel={diff.data.beforeEmpty ? "新增前：不存在" : `${diff.data.beforePath} @ r${diff.data.beforeRevision}`} modifiedLabel={diff.data.afterEmpty ? `r${revision}：已删除` : `${diff.data.path} @ r${revision}`} />}
        </>}
      </div>
    </div>
  </section>;
}
