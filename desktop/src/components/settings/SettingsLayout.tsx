import { useEffect, useRef, useState, type ReactNode } from "react";
import { DockRegion } from "../workspace/WorkbenchDock";
import { Icon } from "../ui/icon";
import { matchText } from "../../lib/pinyin";
import { clearSettingsRequest, useSettingsRequest } from "../../lib/settingsJump";

export interface SettingsSection {
  label: string;
  content: ReactNode;
  /** 搜索用关键词：标签以外的常见叫法（中英文都行）。 */
  keywords?: string[];
}

/** 多个词按「且」组合，每个词可命中标签 / 关键词的原文或拼音首字母。 */
function matches(section: SettingsSection, terms: string[]): boolean {
  const fields = [section.label, ...(section.keywords ?? [])];
  return terms.every((term) =>
    fields.some((field) => field.toLowerCase().includes(term) || !!matchText(term, field)),
  );
}

export function SettingsLayout({ sections }: { sections: SettingsSection[] }) {
  const [selected, setSelected] = useState(sections[0]?.label);
  const [query, setQuery] = useState("");
  /** 被外部请求点亮的分类：2 秒后褪掉，用户知道「就是这一块」。 */
  const [flash, setFlash] = useState<string | null>(null);
  const jump = useSettingsRequest();
  const seen = useRef(0);
  // 渲染期消费一次性请求（和 `WorkbenchShell` 一样是幂等写 ref）：
  // 放 effect 里会因为清空请求把 2 秒计时器一起清掉。
  if (jump && jump.nonce !== seen.current) {
    seen.current = jump.nonce;
    if (jump.section !== selected) setSelected(jump.section);
    if (query) setQuery("");
    setFlash(jump.section);
  }
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => {
      setFlash(null);
      clearSettingsRequest();
    }, 2000);
    return () => clearTimeout(t);
  }, [flash]);
  // 2 秒内离开设置页：定时器被清掉，请求会一直留着，下次进来又跳一遍。
  useEffect(() => () => clearSettingsRequest(), []);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = terms.length ? sections.filter((s) => matches(s, terms)) : sections;
  // 当前选中项被搜索过滤掉时直接显示第一个命中项；不改 selected，清空搜索后回到原位置。
  const current = visible.some((s) => s.label === selected) ? selected : visible[0]?.label;
  return <div className="wb-settings-layout">
    <DockRegion region="sidebar">
      <div className="wb-settings-menu">
        <div className="wb-settings-search">
          <Icon name="search" size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索设置…"
            aria-label="搜索设置"
            spellCheck={false}
          />
          {query && (
            <button type="button" className="wb-settings-clear" aria-label="清除搜索" onClick={() => setQuery("")}>
              <Icon name="close" size={13} aria-hidden="true" />
            </button>
          )}
        </div>
        <nav className="wb-settings-nav" aria-label="设置分类">
          {visible.map((section) => (
            <button
              key={section.label}
              type="button"
              aria-current={current === section.label ? "page" : undefined}
              onClick={() => setSelected(section.label)}
            >
              {section.label}
            </button>
          ))}
        </nav>
        {terms.length > 0 && (
          <p className="wb-settings-count" role="status" aria-live="polite">
            {visible.length ? `匹配 ${visible.length} 个分类` : "没有匹配的分类"}
          </p>
        )}
      </div>
    </DockRegion>
    <div className="wb-settings-body">
      {visible.length === 0 ? (
        <div className="wb-settings-empty">
          <Icon name="search" size={28} aria-hidden="true" />
          <p>没有找到与「{query.trim()}」相关的设置</p>
          <button type="button" onClick={() => setQuery("")}>清除搜索</button>
        </div>
      ) : (
        sections.map((section) => (
          <section
            key={section.label}
            hidden={current !== section.label}
            className={flash === section.label ? "wb-settings-flash" : undefined}
          >
            <h1>{section.label}</h1>
            {section.content}
          </section>
        ))
      )}
    </div>
  </div>;
}
