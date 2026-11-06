import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import type { LogPanelForm } from "../../lib/logPanelStore";
import type { LogCounts } from "../../lib/serverLog";
import type { RefObject } from "react";

interface Props {
  form: LogPanelForm; set: (patch: Partial<LogPanelForm>) => void; counts: LogCounts; matchedCount: number;
  matchIndex: number; matchCount: number; onMatch: (direction: number) => void; findRef: RefObject<HTMLInputElement>;
  previous: boolean; busy: string | null; selected: string; onCopy: () => void; onCopySelection: () => void;
  onClear: () => void; onExport: (complete: boolean) => void; onReload: () => void; onFollow: () => void;
}
export function ServiceLogToolbar({ form, set, counts, matchedCount, matchIndex, matchCount, onMatch, findRef, previous, busy, selected, onCopy, onCopySelection, onClear, onExport, onReload, onFollow }: Props) {
  return <>
    <div className="sc-log-toolbar">
      <div className="sc-log-levels" aria-label="日志级别">{([['all', '全部'], ['warn', '警告'], ['error', '错误']] as const).map(([level, label]) => <button type="button" key={level} aria-pressed={form.level === level} onClick={() => set({ level, scrollTop: 0 })}>{label}<span>{counts[level]}</span></button>)}</div>
      <button type="button" className="sc-log-button sc-log-filter-toggle" aria-expanded={form.filterOpen} onClick={() => set({ filterOpen: !form.filterOpen })}><Icon name="sliders" size={12} />过滤{form.keyword && <i className="sc-log-filter-dot" />}</button>
      <span className="sc-log-spacer" />
      <button type="button" className="sc-log-button" aria-expanded={form.findOpen} title="查找日志（Ctrl+F）" onClick={() => { set({ findOpen: !form.findOpen }); if (!form.findOpen) requestAnimationFrame(() => findRef.current?.focus()); }}><Icon name="search" size={12} />查找</button>
      <button type="button" className="sc-log-button" aria-pressed={form.follow} disabled={previous} onClick={onFollow}><Icon name="stepInto" size={13} />{form.follow ? '跟随最新' : '已暂停'}</button>
      <button type="button" className="sc-log-button sc-log-wrap-toggle" aria-pressed={form.wrap} onClick={() => set({ wrap: !form.wrap })}><Icon name="log" size={12} />换行</button>
      <Menu portal width="w-80" trigger={(open, toggle) => <button className="sc-log-icon" type="button" aria-label="更多日志操作" aria-expanded={open} aria-haspopup="menu" onClick={toggle}><Icon name="more" size={15} /></button>}>
        {close => <>
          <div className="sc-log-compact-actions"><MenuItem icon="sliders" label={form.filterOpen ? "收起内容过滤" : "过滤日志内容"} onClick={() => { close(); set({ filterOpen: !form.filterOpen }); }} /><MenuItem icon="log" label={form.wrap ? "关闭自动换行" : "开启自动换行"} onClick={() => { close(); set({ wrap: !form.wrap }); }} /></div>
          <MenuItem icon="copy" label={`复制已加载匹配日志 · ${matchedCount} 行`} disabled={!!busy || !matchedCount} onClick={() => { close(); onCopy(); }} />
          <MenuItem icon="copy" label="复制日志选区" disabled={!!busy || !selected} onClick={() => { close(); onCopySelection(); }} />
          <MenuItem icon="upload" label="导出已加载匹配日志…" hint="当前筛选范围" disabled={!!busy || !matchedCount} onClick={() => { close(); onExport(false); }} />
          <MenuItem icon="upload" label="导出完整日志文件…" hint={previous ? '上次运行' : '本次运行快照'} disabled={!!busy} onClick={() => { close(); onExport(true); }} />
          <div className="sc-log-menu-divider" />
          <MenuItem icon="trash" label="清屏 · 磁盘文件保留" disabled={!!busy || previous} onClick={() => { close(); onClear(); }} />
          <MenuItem icon="refresh" label="重新读取当前日志" disabled={!!busy} onClick={() => { close(); onReload(); }} />
          <div className="sc-log-menu-divider" />
          <MenuItem label="增大字号" hint={`${form.fontSize}px`} disabled={form.fontSize >= 18} onClick={() => { close(); set({ fontSize: form.fontSize + 1 }); }} />
          <MenuItem label="减小字号" hint={`${form.fontSize}px`} disabled={form.fontSize <= 11} onClick={() => { close(); set({ fontSize: form.fontSize - 1 }); }} />
        </>}
      </Menu>
    </div>
    {form.filterOpen && <div className="sc-log-filter-row"><Icon name="sliders" size={12} /><input aria-label="过滤日志内容" placeholder="只显示包含此内容的日志" value={form.keyword} onChange={event => set({ keyword: event.target.value, scrollTop: 0 })} /><span>过滤会隐藏其他行</span><button type="button" className="sc-log-button" onClick={() => set({ level: 'all', keyword: '' })}>清除过滤</button></div>}
    {form.findOpen && <div className="sc-log-find-row"><Icon name="search" size={12} /><input ref={findRef} aria-label="查找日志内容" placeholder="查找，不隐藏上下文" value={form.query} onChange={event => set({ query: event.target.value, follow: false })} /><span className="sc-log-find-count">{!form.query.trim() ? '输入关键字' : matchCount ? `${matchIndex + 1} / ${matchCount} 行` : '无匹配'}</span><button type="button" className="sc-log-icon" aria-label="上一个匹配" disabled={!matchCount} onClick={() => onMatch(-1)}><Icon name="arrowUp" size={13} /></button><button type="button" className="sc-log-icon" aria-label="下一个匹配" disabled={!matchCount} onClick={() => onMatch(1)}><Icon name="stepInto" size={13} /></button><button type="button" className="sc-log-icon" aria-label="关闭查找" onClick={() => { set({ query: '', findOpen: false }); findRef.current?.blur(); }}><Icon name="close" size={13} /></button></div>}
  </>;
}
