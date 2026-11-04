import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DockRegion } from "../workspace/WorkbenchDock";
import { Icon } from "../ui/icon";
import { clearSettingsRequest, useSettingsRequest } from "../../lib/settingsJump";
import { revealSetting, searchSettings } from "../../lib/settingsSearch";
import { useSettingsIndex } from "../../hooks/useSettingsIndex";
import { setSideOpen } from "../../lib/layoutStore";
import "../../settings-center.css";

export interface SettingsSection {
  label: string;
  content: ReactNode;
  keywords?: string[];
  group?: string;
  description?: string;
  /** 旧入口仍可以使用原分类名称。 */
  aliases?: string[];
}

export function SettingsLayout({ sections }: { sections: SettingsSection[] }) {
  const [selected, setSelected] = useState(sections[0]?.label);
  const [query, setQuery] = useState("");
  const [flash, setFlash] = useState<{ section: string; id?: string; nonce: number; highlight?: boolean } | null>(null);
  const pages = useRef<HTMLDivElement>(null);
  const index = useSettingsIndex(pages);
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const positions = useRef(new Map<string, number>());
  const seen = useRef(0);
  const jump = useSettingsRequest();
  if (jump && jump.nonce !== seen.current) {
    seen.current = jump.nonce;
    const section = sections.find((s) => s.label === jump.section || s.aliases?.includes(jump.section));
    if (section) {
      setSelected(section.label);
      setQuery("");
      setFlash({ section: section.label, id: jump.binding ? `binding-${jump.binding}` : undefined, nonce: jump.nonce });
    }
  }

  const searching = Boolean(query.trim());
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = searching ? 0 : positions.current.get(selected) ?? 0;
  }, [selected, searching]);

  useLayoutEffect(() => {
    if (!flash || !pages.current || searching) return;
    if (flash.id) {
      const target = revealSetting(pages.current, flash.id);
      target?.classList.add("wb-settings-flash");
      return () => target?.classList.remove("wb-settings-flash");
    }
    pages.current.querySelector<HTMLElement>(":scope > section:not([hidden]) h1")?.focus({ preventScroll: true });
  }, [flash, searching]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => { setFlash(null); clearSettingsRequest(); }, 2000);
    return () => clearTimeout(timer);
  }, [flash]);
  useEffect(() => () => clearSettingsRequest(), []);

  const navigate = (section: string, id?: string) => {
    if (!searching && body.current) positions.current.set(selected, body.current.scrollTop);
    setSelected(section);
    setQuery("");
    const narrow = window.matchMedia?.("(max-width: 650px)").matches;
    // 抽屉退出后不能把焦点留在隐藏分类上；沿用定位逻辑将焦点移到正文。
    setFlash(id || narrow ? { section, id, nonce: Date.now(), highlight: Boolean(id) } : null);
    if (narrow) setSideOpen(false);
  };
  const hits = searchSettings(index, query);
  const groups = [...new Set(sections.map((s) => s.group ?? "设置"))];
  return <div className="wb-settings-layout">
    <DockRegion region="sidebar">
      <div className="wb-settings-menu">
        <div className="wb-settings-search" data-focus-container>
          <Icon name="search" size={14} aria-hidden="true" />
          <input ref={search} value={query} onChange={(e) => {
            if (!searching && body.current) positions.current.set(selected, body.current.scrollTop);
            setQuery(e.target.value);
          }} placeholder="搜索设置项…" aria-label="搜索设置" spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
              if (e.key === "Enter" && hits[0]) { e.preventDefault(); navigate(hits[0].section, hits[0].id ?? undefined); }
            }} />
          {query && <button type="button" className="wb-settings-clear" aria-label="清除搜索" onClick={() => { setQuery(""); search.current?.focus(); }}><Icon name="close" size={13} aria-hidden="true" /></button>}
        </div>
        <nav className="wb-settings-nav" aria-label="设置分类">
          {groups.map((group) => <div className="wb-settings-nav-group" key={group}>
            <div className="wb-settings-nav-heading">{group}</div>
            {sections.filter((s) => (s.group ?? "设置") === group).map((section) => <button key={section.label} type="button" aria-current={!searching && selected === section.label ? "page" : undefined} onClick={() => navigate(section.label)}>{section.label}</button>)}
          </div>)}
        </nav>
      </div>
    </DockRegion>
    <div ref={body} className="wb-settings-body" onScroll={() => {
      if (!searching && body.current) positions.current.set(selected, body.current.scrollTop);
    }}>
      {searching && <section className="wb-settings-results" aria-label="设置搜索结果">
        <header className="wb-settings-page-header"><h1>搜索结果</h1><p role="status">找到 {hits.length} 项与「{query.trim()}」相关的设置</p></header>
        {hits.length ? <div className="wb-settings-result-list">{hits.map((hit) => <button type="button" className="wb-settings-result" key={`${hit.section}:${hit.id}`} onClick={() => navigate(hit.section, hit.id ?? undefined)}>
          <span className="wb-settings-result-main"><strong>{hit.label}</strong><span>{hit.description}</span><small>{[hit.group, hit.section].filter(Boolean).join(" / ")}</small></span>
          <span className="wb-settings-result-value" title={hit.value}>{hit.value || "查看设置"}</span><Icon name="chevronRight" size={14} aria-hidden="true" />
        </button>)}</div> : <div className="wb-settings-empty"><Icon name="search" size={28} aria-hidden="true" /><p>没有找到相关设置，试试「字体」「密度」或「内存」</p><button type="button" onClick={() => { setQuery(""); search.current?.focus(); }}>清除搜索</button></div>}
      </section>}
      <div ref={pages} className="wb-settings-pages">
        {sections.map((section) => <section key={section.label} data-settings-section={section.label} data-settings-group={section.group} data-settings-description={section.description} data-settings-keywords={section.keywords?.join(" ")}
          hidden={searching || selected !== section.label} className={flash?.section === section.label && !flash.id && flash.highlight !== false ? "wb-settings-flash" : undefined}>
          <header className="wb-settings-page-header"><h1 tabIndex={-1}>{section.label}</h1>{section.description && <p>{section.description}</p>}</header>
          <div className="wb-settings-section-content">{section.content}</div>
        </section>)}
      </div>
    </div>
  </div>;
}
