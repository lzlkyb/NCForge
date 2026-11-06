import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useWorkbenchLayout } from "../../lib/workbenchLayout";
import type { useDebugSnapshot } from "../../lib/debugSession";
import { debugTargetLabel } from "../../lib/debug";
import { DebugVariables } from "./DebugVariables";
import { DebugWatch } from "./DebugWatch";
import "../../diagnostic-workspace.css";

let dock: HTMLElement | null = null, mounted = false;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const notify = () => listeners.forEach(cb => cb());
const setDock = (value: HTMLElement | null) => { if (dock !== value) { dock = value; notify(); } };

export function DebugInspectorDock() {
  const layout = useWorkbenchLayout();
  const host = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null);
  const active = useSyncExternalStore(subscribe, () => mounted, () => false);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const parent = host.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(entry.contentRect.width); });
    observer.observe(parent); return () => observer.disconnect();
  }, []);
  const visible = active && layout.mode === "debug" && width >= 850;
  useLayoutEffect(() => { if (visible) setDock(body.current); else setDock(null); return () => setDock(null); }, [visible]);
  return <aside className="dw-debug-dock" ref={host} hidden={!visible} aria-label="调试检查器"><header><strong>变量与监视</strong><span>当前调试目标</span></header><div className="dw-debug-dock-body" ref={body} /></aside>;
}

/** Move one stable portal container between hosts; resizing preserves watch drafts and expanded variable rows. */
export function DebugInspectorContent({ snap }: { snap: ReturnType<typeof useDebugSnapshot> }) {
  const target = useSyncExternalStore(subscribe, () => dock, () => null);
  const [container] = useState(() => document.createElement("div"));
  const inline = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { mounted = true; notify(); return () => { mounted = false; notify(); }; }, []);
  useLayoutEffect(() => {
    const destination = target ?? inline.current;
    if (!destination || container.parentElement === destination) return;
    const focus = container.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    // A fallback DOM move can emit blur. It must not commit an unfinished variable edit.
    container.dataset.relocating = "true";
    destination.appendChild(container);
    focus?.focus({ preventScroll: true });
    delete container.dataset.relocating;
  }, [container, target]);
  useLayoutEffect(() => () => container.remove(), [container]);
  const frame = snap.frames.find(f => f.id === snap.frameId);
  return <div className="dbg-col dw-debug-inline" ref={inline} data-docked={!!target || undefined}>
    {createPortal(<div className="dw-debug-inspector"><div className="dbg-col-h">{debugTargetLabel(snap.target)} · 监视</div><DebugWatch paused={snap.paused} watches={snap.watches} /><div className="dbg-col-h">变量{frame && <span> · {frame.name}</span>}</div><div className="dbg-list"><DebugVariables paused={snap.paused} scopes={snap.scopes} variables={snap.variables} /></div></div>, container)}
  </div>;
}
