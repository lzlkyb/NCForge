import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { EditorNavRow } from "./EditorNavRow";
import { OutlinePanel } from "./OutlinePanel";

type Navigation = ComponentProps<typeof EditorNavRow>;

export function EditorReadingLayout({ nav, split, pinned, onTogglePin, onCloseOutline, onJump, children }: {
  nav: Navigation | null;
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
    {nav && <EditorNavRow {...nav} />}
    <div className="wb-reading-body">
      {children}
      {nav && <OutlinePanel open={nav.outlineOpen && !nav.active.virtual} path={nav.active.path}
        mtimeMs={nav.active.mtimeMs} dirty={nav.active.dirty} onClose={onCloseOutline} onJump={onJump}
        pinned={pinned && canPin} onTogglePin={canPin ? onTogglePin : undefined} />}
    </div>
  </div>;
}
