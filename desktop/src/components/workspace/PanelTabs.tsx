import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { PanelTab } from "./BottomPanel";
import { PRIMARY_PANELS, SECONDARY_PANELS, revealWorkbenchPanel, togglePinnedPanel, useWorkbenchLayout } from "../../lib/workbenchLayout";
import { Menu, MenuItem } from "../ui/Menu";
import { Icon } from "../ui/icon";

export const PANEL_NAMES: Record<PanelTab, string> = { problems: "问题", changes: "改动", run: "运行", build: "编译输出", svc: "NC 服务", calls: "调用层级", types: "类型层级", relations: "代码关系", todo: "待办", bookmarks: "书签", debug: "调试", tests: "Java 运行 / 测试" };
const ORDER: PanelTab[] = ["problems", "changes", "run", "relations", "todo", "bookmarks"];
const groupOf = (panel: PanelTab): PanelTab => ["build", "svc", "debug", "tests"].includes(panel) ? "run" : panel === "calls" || panel === "types" ? "relations" : panel;
export function PanelTabs({ tab, onTab, errors, paused, disabled = false }: { tab: PanelTab; onTab: (tab: PanelTab) => void; errors: number; paused: boolean; disabled?: boolean }) {
  const layout = useWorkbenchLayout();
  const grouped = groupOf(tab), lastRun = useRef<PanelTab>("build");
  if (grouped === "run") lastRun.current = tab;
  const visible = ORDER.filter(p => PRIMARY_PANELS.includes(p) || layout.pinned.includes(p) || p === grouped);
  const tabRefs = useRef(new Map<PanelTab, HTMLButtonElement>());
  const select = (panel: PanelTab) => { if (disabled) return; const selected = panel === "run" ? lastRun.current : panel; revealWorkbenchPanel(selected); onTab(selected); };
  useLayoutEffect(() => {
    const selected = tabRefs.current.get(grouped), list = selected?.parentElement;
    if (!list) return;
    const reveal = () => selected?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal); observer.observe(list); return () => observer.disconnect();
  }, [tab, layout.pinned, grouped]);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
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
        role="tab" id={`wb-ptab-${panel === grouped ? tab : panel}`} aria-selected={grouped === panel} aria-controls="wb-panel-body" tabIndex={grouped === panel ? 0 : -1}
        className="wb-ptab" disabled={disabled} data-active={grouped === panel || undefined} onClick={() => select(panel)}>
        {PANEL_NAMES[panel]}{panel === "problems" && errors > 0 && <span className="wb-ptab-n">{errors}</span>}
        {panel === "run" && paused && <span className="wb-ptab-live" title="调试已暂停（中间件或客户端）" />}
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
