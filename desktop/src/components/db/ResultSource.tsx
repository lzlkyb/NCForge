import { CodePreview } from "./CodePreview";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icon";
import type { ResultSnapshot } from "../../lib/dbResultTools";

/** Render outside the result's scroll container so a short result pane cannot clip its provenance. */
export function ResultSource({ snapshot, meta }: { snapshot: ResultSnapshot; meta: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); anchor.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect(), p = panel.current;
      if (!a || !p) return;
      setPosition({ left: Math.max(12, Math.min(a.right - p.offsetWidth, window.innerWidth - p.offsetWidth - 12)),
        top: Math.max(12, Math.min(a.bottom + 6, window.innerHeight - p.offsetHeight - 12)) });
    };
    place(); panel.current?.querySelector("pre")?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); anchor.current?.focus({ preventScroll: true });
    };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside, true); window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", key, true); window.removeEventListener("scroll", scroll, true); };
  }, [open]);
  return <>
    <button ref={anchor} type="button" className="dbx-ibtn" title="查看结果来源 · SQL、连接与 schema" aria-label="查看查询来源" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <Icon name="querySource" size={14} />
    </button>
    {open && createPortal(<div ref={panel} className="dbx-source-popover" style={position} role="dialog" aria-modal="false" aria-label="查询来源">
      <header><strong>查询来源</strong><button type="button" className="dbx-ibtn" aria-label="关闭查询来源" onClick={close}><Icon name="close" size={14} /></button></header>
      <div className="dbx-source-meta"><span>{snapshot.source}</span><time>{new Date(snapshot.at).toLocaleString()}</time></div>
      {snapshot.schema !== undefined && <div className="dbx-source-meta">执行 schema：{snapshot.schema || "登录账号"}</div>}
      <div className="dbx-source-meta"><span>{snapshot.complete ? "完整查询结果" : "已读取部分数据"}</span>{meta}</div>
      <CodePreview expandable={false} label="已执行的 SQL" text={snapshot.sql}/>
    </div>, document.body)}
  </>;
}
