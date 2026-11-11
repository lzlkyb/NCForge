import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CHANGELOG, CATEGORY_LABELS, type ChangeCategory, type ChangelogEntry } from "../../lib/about";
import { useAppInfo } from "../../hooks/useAppInfo";
import { isImeComposing, markChangelogSeen, compareVersion } from "../../lib/utils";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ReleaseText } from "./ReleaseText";
import { groupReleaseItems } from "../../lib/releaseReading";
import { ReleaseItem } from "./ReleaseItem";
import "./settings-about.css";

const CATEGORIES: ChangeCategory[] = ["feat", "improve", "fix", "sec"];
const PAGE_SIZE = 12;

export function VersionHistoryDialog({ open, onClose, entries = CHANGELOG }: {
  open: boolean; onClose: () => void; entries?: ChangelogEntry[];
}) {
  const info = useAppInfo();
  const currentVersion = info.data?.version?.replace(/^v/, "");
  const [version, setVersion] = useState(entries[0]?.version ?? "");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ChangeCategory | "all">("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const body = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  useLayoutEffect(() => {
    if (!open) { initialized.current = false; return; }
    if (initialized.current) return;
    initialized.current = true;
    setVersion(entries.find(entry => entry.version === currentVersion)?.version ?? entries[0]?.version ?? "");
    setQuery(""); setCategory("all"); setLimit(PAGE_SIZE);
  }, [open, currentVersion, entries]);
  const entry = entries.find(item => item.version === version) ?? entries[0];
  useEffect(() => {
    if (open && entry && currentVersion && compareVersion(entry.version, currentVersion) <= 0) markChangelogSeen(entry.version);
  }, [open, entry, currentVersion]);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => terms.every(term => text.toLocaleLowerCase().includes(term));
  const items = entry?.items.filter(item => (category === "all" || item.category === category) && matches(item.text)) ?? [];
  const visible = items.slice(0, limit);
  const resetScroll = () => { setLimit(PAGE_SIZE); if (body.current) body.current.scrollTop = 0; };
  const clear = () => { setQuery(""); setCategory("all"); resetScroll(); };
  return <Modal open={open} onClose={onClose} ariaLabel="更新历史" className="modal-surface settings-about-dialog settings-about-history">
    <header className="settings-about-dialog-head"><div><h2>更新历史</h2><p>按版本阅读，搜索你关心的功能和修复。</p></div>
      <Button variant="ghost" size="icon" aria-label="关闭更新历史" onClick={onClose}><Icon name="close" size={16} /></Button></header>
    {entries.length > 0 && <div className="settings-about-history-tools">
      <select className="input" aria-label="选择更新版本" value={entry?.version ?? ""} onChange={event => { setVersion(event.target.value); resetScroll(); }}>
        {entries.map(item => <option key={item.version} value={item.version}>v{item.version}{item.version === currentVersion ? " · 当前版本" : ""}</option>)}
      </select>
      <div className="settings-about-search" data-focus-container><Icon name="search" size={14} aria-hidden="true" />
        <input type="search" value={query} aria-label="搜索更新记录" placeholder="搜索本版本更新…" onChange={event => { setQuery(event.target.value); resetScroll(); }}
          onKeyDownCapture={event => { if (event.key === "Escape" && query && !isImeComposing(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); setQuery(""); resetScroll(); } }} />
        {query && <Button variant="ghost" size="icon" aria-label="清除更新搜索" onClick={() => { setQuery(""); resetScroll(); }}><Icon name="close" size={13} /></Button>}
      </div>
      <div className="settings-about-filters" role="group" aria-label="更新类别">
        <button type="button" aria-pressed={category === "all"} onClick={() => { setCategory("all"); resetScroll(); }}>全部</button>
        {CATEGORIES.map(value => <button key={value} type="button" aria-pressed={category === value} onClick={() => { setCategory(value); resetScroll(); }}>{CATEGORY_LABELS[value]}</button>)}
      </div>
    </div>}
    <div ref={body} className="settings-about-history-body" aria-label="版本记录内容" tabIndex={0}>
      {entry ? <>
        <div className="settings-about-history-meta"><h3>v{entry.version}</h3><span>记录日期 {entry.date}</span></div>
        {!terms.length && category === "all" && (entry.summary ?? entry.highlights ?? []).map((text, index) => <p className="settings-about-release-summary" key={index}><ReleaseText text={text} /></p>)}
        {groupReleaseItems(visible.map(item => ({label: CATEGORY_LABELS[item.category], text:item.text}))).map(group => <section className="settings-about-history-group" key={group.label}><h4>{group.label}</h4>
          <ul>{group.items.map((text, index) => <li key={index}><ReleaseItem text={text} /></li>)}</ul></section>)}
        {items.length > limit && <Button variant="link" size="sm" onClick={() => setLimit(items.length)}>展开全部 {items.length} 条记录</Button>}
        {!items.length && <div className="settings-about-empty" role="status"><p>{terms.length ? "没有找到相关记录，试试其他关键词。" : category === "all" ? "这个版本没有条目记录。" : "这个版本没有此类别的记录。"}</p>
          {(query || category !== "all") && <Button variant="link" size="sm" onClick={clear}>清除筛选</Button>}</div>}

      </> : <div className="settings-about-empty" role="status"><p>还没有随包版本记录。</p></div>}
    </div>
    <footer className="settings-about-dialog-foot"><span aria-live="polite">{entry ? `显示 ${visible.length} / ${items.length} 条 · ${entries.length} 个随包版本` : "暂无版本记录"}</span>
      <Button variant="outline" size="sm" onClick={onClose}>关闭</Button></footer>
  </Modal>;
}
