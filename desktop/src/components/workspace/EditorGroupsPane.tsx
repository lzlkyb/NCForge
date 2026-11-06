import { useLayoutEffect, useRef, useState } from "react";
import { getSession, setSession, useWorkspaceSelector, type TabMeta } from "../../lib/workspaceSession";
import { activeOfGroup, emptyEditorGroups, moveGroupFile, removeGroupView, type EditorGroupId } from "../../lib/editorGroups";
import { setCursor } from "../../lib/cursorStore";
import { LARGE_FILE_LINES } from "../../lib/largeFile";
import { filePathKey } from "../../lib/workspace";
import { EditorPane } from "./EditorPane";
import { TabStrip } from "./TabStrip";
import { EmptyEditor } from "./EmptyEditor";
import type { useFileSession } from "../../hooks/useFileSession";
import "../../editor-groups.css";

export function EditorGroupsPane({ root, tabs, session, reveal }: {
  root: string; tabs: TabMeta[]; session: ReturnType<typeof useFileSession>;
  reveal: { line: number; column?: number; nonce: number; path?: string; group?: EditorGroupId } | null;
}) {
  const groups = useWorkspaceSelector(s => s.editorGroups) ?? emptyEditorGroups();
  const host = useRef<HTMLDivElement>(null), cleanup = useRef<(() => void) | null>(null);
  const [width, setWidth] = useState(0), compact = width > 0 && width < 850;
  useLayoutEffect(() => {
    const element = host.current; if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(entry.contentRect.width); });
    observer.observe(element); return () => { observer.disconnect(); cleanup.current?.(); };
  }, []);
  const focus = (group: EditorGroupId) => {
    if (getSession().editorGroups?.focused !== group) setSession({ editorGroups: old => ({ ...(old ?? emptyEditorGroups()), focused: group }) });
  };
  const closeView = (group: EditorGroupId, path: string) => {
    const current = getSession().editorGroups ?? emptyEditorGroups(), other = group === "left" ? "right" : "left";
    if (current[other].includes(path)) setSession({ editorGroups: removeGroupView(current, group, path) });
    else session.closeTab(path);
  };
  const resize = (start: number) => {
    cleanup.current?.(); const bounds = host.current?.getBoundingClientRect(); if (!bounds?.width) return;
    const initial = getSession().editorGroups?.ratio ?? .5;
    const move = (event: PointerEvent) => setSession({ editorGroups: old => ({ ...(old ?? emptyEditorGroups()), ratio: initial + (event.clientX - start) / bounds.width }) });
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); cleanup.current = null; };
    cleanup.current = finish; window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish);
  };
  const split = groups.right.length > 0;
  return <div ref={host} className="wb-editor-groups" data-compact={compact || undefined} data-split={split || undefined}>
    {(["left", "right"] as const).filter(group => group === "left" || split).map((group, index) => {
      const activePath = activeOfGroup(groups, group), active = tabs.find(t => t.path === activePath);
      const groupTabs = groups[group].map(path => tabs.find(t => t.path === path)).filter((tab): tab is TabMeta => !!tab).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
      const focused = groups.focused === group;
      return <div key={group} className="wb-editor-group-slot" data-group={group} data-focused={focused || undefined} hidden={split && compact && !focused} style={{ flexBasis: !split || compact ? '100%' : `${(index ? 1 - groups.ratio : groups.ratio) * 100}%` }}>
        <TabStrip root={root} tabs={groupTabs} activePath={activePath} splitPath={groups.rightActive} groupId={group} compactTools
          compiling={false} canCompile={false} onCompile={() => {}} onSelect={path => { focus(group); session.selectTab(path); }}
          onClose={path => closeView(group, path)} onCloseMany={want => {
            focus(group); let kept = 0;
            groupTabs.filter((tab, i) => !tab.pinned && want(tab, i)).forEach(tab => {
              const other = group === "left" ? "right" : "left";
              if (getSession().editorGroups?.[other].includes(tab.path) || !tab.dirty && !tab.eolChanged) closeView(group, tab.path);
              else kept++;
            }); return kept;
          }}
          onPin={session.pin} onOpenSplit={path => void session.openSplit(path)} onCloseSplit={session.closeSplit}
          onMoveGroup={path => setSession({ tabs: tabs => tabs.map(tab => tab.path === path && tab.preview ? { ...tab, previewGroup: group === "left" ? "right" : "left" } : tab), editorGroups: old => moveGroupFile(old ?? emptyEditorGroups(), group, path) })} />
        <div id={`wb-editor-${group}-surface`} role="tabpanel" aria-label={`${group === "left" ? "左" : "右"}编辑器组内容`} className="wb-editor-body">
          <EditorPane groupId={group} focused={focused} onFocus={() => focus(group)} activePath={activePath} readOnly={active?.readOnly ?? false} heavy={(active?.lines ?? 0) > LARGE_FILE_LINES}
            reveal={focused && (!reveal?.group || reveal.group === group) && (!reveal?.path || filePathKey(reveal.path) === filePathKey(activePath ?? "")) ? reveal : null} onCursor={(line, column) => { if (getSession().editorGroups?.focused === group) setCursor(line, column); }}
            onSave={prepare => { if (activePath) void session.saveFile(activePath, false, undefined, prepare); }} />
          {!active && <EmptyEditor root={root} onOpen={path => { focus(group); void session.openFile(path); }} />}
        </div>
      </div>;
    })}
    {split && !compact && <div className="wb-editor-divider" role="separator" aria-label="调整编辑器组比例" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(groups.ratio * 100)} tabIndex={0}
      style={{ left: `${groups.ratio * 100}%` }} onPointerDown={event => { event.preventDefault(); resize(event.clientX); }} onDoubleClick={() => setSession({ editorGroups: old => ({ ...(old ?? emptyEditorGroups()), ratio: .5 }) })}
      onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return; event.preventDefault(); setSession({ editorGroups: old => ({ ...(old ?? emptyEditorGroups()), ratio: event.key === 'Home' ? .5 : (old?.ratio ?? .5) + (event.key === 'ArrowRight' ? .05 : -.05) }) }); }} />}
  </div>;
}
