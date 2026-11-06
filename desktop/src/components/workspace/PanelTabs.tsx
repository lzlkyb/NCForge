import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { PanelTab } from "./BottomPanel";
import { PRIMARY_PANELS, SECONDARY_PANELS, revealWorkbenchPanel, togglePinnedPanel, useWorkbenchLayout } from "../../lib/workbenchLayout";
import { Menu, MenuItem } from "../ui/Menu";
import { Icon } from "../ui/icon";

export const PANEL_NAMES: Record<PanelTab, string> = { problems: "问题", build: "编译输出", svc: "NC 服务", calls: "调用层级", types: "类型层级", todo: "待办", bookmarks: "书签", debug: "调试" };
const ORDER: PanelTab[] = ["problems", "build", "svc", "calls", "types", "todo", "bookmarks", "debug"];
export function PanelTabs({ tab, onTab, errors, paused }: { tab: PanelTab; onTab: (tab: PanelTab) => void; errors: number; paused: boolean }) {
  const layout = useWorkbenchLayout();
  const visible = ORDER.filter(p => PRIMARY_PANELS.includes(p) || layout.pinned.includes(p) || p === tab);
  const tabRefs = useRef(new Map<PanelTab, HTMLButtonElement>());
  const select = (panel: PanelTab) => { revealWorkbenchPanel(panel); onTab(panel); };
  useLayoutEffect(() => {
    const selected = tabRefs.current.get(tab), list = selected?.parentElement;
    if (!list) return;
    const reveal = () => selected?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal); observer.observe(list); return () => observer.disconnect();
  }, [tab, layout.pinned]);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = visible.findIndex(panel => tabRefs.current.get(panel) === event.target);
    if (index < 0 || event.nativeEvent.isComposing) return;
    const length = visible.length;
    const next = event.key === "ArrowLeft" ? (index - 1 + length) % length : event.key === "ArrowRight" ? (index + 1) % length : event.key === "Home" ? 0 : event.key === "End" ? length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); select(visible[next]); tabRefs.current.get(visible[next])?.focus();
  };
  return <>
    <div className="wb-ptabs" role="tablist" aria-label="底部面板" onKeyDown={onKey}>
      {visible.map(panel => <button key={panel} ref={node => { if (node) tabRefs.current.set(panel, node); else tabRefs.current.delete(panel); }} type="button"
        role="tab" id={`wb-ptab-${panel}`} aria-selected={tab === panel} aria-controls="wb-panel-body" tabIndex={tab === panel ? 0 : -1}
        className="wb-ptab" data-active={tab === panel || undefined} onClick={() => select(panel)}>
        {PANEL_NAMES[panel]}{panel === "problems" && errors > 0 && <span className="wb-ptab-n">{errors}</span>}
        {panel === "debug" && paused && <span className="wb-ptab-live" title="调试已暂停（中间件或客户端）" />}
      </button>)}
    </div>
    <Menu portal width="w-64" trigger={(open, toggle) => <button type="button" className="wb-icon-btn" aria-label="更多底部工具" title="更多底部工具" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="more" size={14} /></button>}>
      {close => <>{SECONDARY_PANELS.map(panel => <div className="wb-panel-tool-option" key={panel}>
        <MenuItem label={PANEL_NAMES[panel]} active={tab === panel} onClick={() => { close(); select(panel); }} />
        <button type="button" className="wb-icon-btn" aria-label={`${layout.pinned.includes(panel) ? "取消固定" : "固定"}${PANEL_NAMES[panel]}`} title={layout.pinned.includes(panel) ? "取消固定" : "固定到页签条"} aria-pressed={layout.pinned.includes(panel)} onClick={() => togglePinnedPanel(panel)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 3 21 8l-3 1-4 4 1 4-2 2-5-5-5-5 2-2 4 1 4-4zM8 16l-5 5" /></svg></button>
      </div>)}</>}
    </Menu>
  </>;
}
