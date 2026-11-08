import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { EditorNavigation } from "./EditorNavRow";
import { OutlinePanel } from "./OutlinePanel";
import { HistoryPanel } from "./HistoryPanel";

export function EditorReadingLayout({ nav, split, pinned, onTogglePin, onCloseOutline, onJump, children }: {
  nav: EditorNavigation | null;
  split: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  onCloseOutline: () => void;
  onJump: (line: number, column?: number) => void;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      // The workbench hides the code surface while another tool is open.
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const canPin = width >= (split ? 1100 : 790);
  return <div className="wb-reading-layout" ref={host}>
    <div className="wb-reading-body">
      {children}
      {/* 历史面板只挂载一份，切换焦点组时不随组内工具条销毁。 */}
      {nav && <HistoryPanel open={nav.history.open && !nav.active.virtual} path={nav.active.path}
        dirty={nav.history.dirty} onClose={nav.history.onClose} onRestored={nav.history.onRestored} />}
      {nav && <OutlinePanel open={nav.outlineOpen && !nav.active.virtual} path={nav.active.path}
        mtimeMs={nav.active.mtimeMs} dirty={nav.active.dirty} onClose={onCloseOutline} onJump={onJump}
        pinned={pinned && canPin} onTogglePin={canPin ? onTogglePin : undefined} />}
    </div>
  </div>;
}
