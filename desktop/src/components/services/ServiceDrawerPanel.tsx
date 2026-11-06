import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "../ui/icon";

/** 非模态详情按需占宽；关闭后恢复触发按钮焦点，不截断代码/日志的日常操作。 */
export function ServiceDrawerPanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  return <aside className="sc-drawer" aria-label={title} onKeyDown={e => { if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[role="dialog"][aria-modal="true"]')) { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
    <div className="sc-drawer-head"><strong>{title}</strong><button type="button" ref={closeRef} className="sv-icon-btn" aria-label="关闭服务详情" onClick={onClose}><Icon name="close" size={15} /></button></div>
    <div className="sc-drawer-body">{children}</div>
  </aside>;
}
