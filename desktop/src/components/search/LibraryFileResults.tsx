import { useEffect, useState, useSyncExternalStore } from "react";
import { getSearchForm, setSearchForm, subscribeSearchForm } from "../../lib/searchStore";
import { cancelLibrarySearch, searchLibraryFiles, type LibraryHit } from "../../lib/libraryFiles";
import { Icon } from "../ui/icon";

/** 库文件只读结果独立存放，不能进入工作区替换或编辑匹配范围。 */
export function LibraryFileResults({ onOpen }: { onOpen: (hit: LibraryHit) => void }) {
  const form = useSyncExternalStore(subscribeSearchForm, getSearchForm, getSearchForm);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const done = !form.running && !!form.outcomeQuery && (form.outcome !== null || form.projectOutcome !== null);
  const options = form.libraryOptions;
  const resultId = form.resultId;
  useEffect(() => {
    if (!done || !options) { setLoading(false); return; }
    if (!retry && getSearchForm().libraryFiles && !getSearchForm().libraryFiles?.building) return;
    let alive = true;
    const current = () => alive && resultId === getSearchForm().resultId && options === getSearchForm().libraryOptions;
    const source = `library-content:${resultId}:${retry}`;
    setLoading(true);
    searchLibraryFiles(options, false, source).then(result => { if (current()) setSearchForm({ libraryFiles: result }); })
      .catch(error => { if (current()) setSearchForm({ libraryFiles: { items: [], building: false, stale: false, cancelled: false,
        truncated: false, scanned: 0, skipped: 0, error: String(error) } }); })
      .finally(() => { if (current()) setLoading(false); });
    return () => { alive = false; void cancelLibrarySearch(source); };
  }, [done, options, resultId, retry]);
  if (!done || !options) return null;
  const result = form.libraryFiles;
  return <section className="flex-shrink-0 border-b border-border" aria-label="库文件内容">
    <div className="flex flex-wrap items-center gap-2 bg-muted/40 px-3 py-1 text-[12px]">
      <Icon name="package" size={13} className="text-muted-foreground" />
      <span className="font-semibold">库文件内容</span>
      <span className="text-muted-foreground">JAR 与扩展目录 · 只读</span>
      <span role="status" className="text-muted-foreground">{loading ? "搜索中…" : result?.building ? "正在后台建立文本目录，稍后重试" : `显示 ${result?.items.length ?? 0} 处`}</span>
      {(result?.building || result?.stale || result?.error || result?.cancelled) &&
        <button type="button" disabled={loading} className="text-primary underline underline-offset-2 disabled:opacity-50" onClick={() => setRetry(n => n + 1)}>重试</button>}
    </div>
    {result?.error && <p role="alert" className="px-3 py-1 text-[12px] text-destructive">库文件搜索失败：{result.error}</p>}
    {result?.stale && <p className="px-3 py-1 text-[12px] text-muted-foreground">库文件目录正在更新，结果可能不全。</p>}
    {result?.truncated && <p className="px-3 py-1 text-[12px] text-muted-foreground">达到结果或时间上限，请缩小关键词或文件范围。</p>}
    {!!result?.skipped && <p className="px-3 py-1 text-[12px] text-muted-foreground">有 {result.skipped} 个文件或来源因大小、读取或缓存上限被跳过。</p>}
    {result?.cancelled && <p className="px-3 py-1 text-[12px] text-muted-foreground">库文件搜索已取消，结果可能不全。</p>}
    {result?.items.map((hit, i) => <button type="button" key={`${hit.source}:${hit.entry}:${hit.line}:${i}`} onClick={() => onOpen(hit)}
      title={`${hit.source}${hit.archive ? " ! " : "/"}${hit.entry}:${hit.line}`}
      className="block w-full border-t border-border px-3 py-2 text-left hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
      <div className="text-[12px] font-semibold">{hit.entry.split("/").pop()} : {hit.line}</div>
      <div className="break-all text-[11px] text-muted-foreground">{hit.source}{hit.archive ? " ! " : "/"}{hit.entry}</div>
      <div className="break-all font-mono text-[12px]">{highlight(hit.text, hit.ranges)}</div>
    </button>)}
  </section>;
}
function highlight(text: string, ranges: LibraryHit["ranges"]) {
  let at = 0;
  const parts: React.ReactNode[] = [];
  for (const [i, range] of ranges.entries()) {
    parts.push(text.slice(at, range.start), <mark key={i} className="bg-warning/20 text-foreground">{text.slice(range.start, range.end)}</mark>);
    at = range.end;
  }
  parts.push(text.slice(at));
  return parts;
}
