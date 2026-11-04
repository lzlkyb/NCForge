import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Modal } from "../ui/Modal";
import { usePresence } from "../../hooks/usePresence";
export function SvnCommitDrawer({ host, open, onClose, children }: { host: RefObject<HTMLDivElement>; open: boolean; onClose: () => void; children: ReactNode }) {
  const [narrow,setNarrow] = useState(true), surface = useRef<HTMLElement>(null);
  const {mounted,entered} = usePresence(open);
  useEffect(() => { const el = host.current; if (!el) return; const observer = new ResizeObserver(entries => setNarrow((entries[0]?.contentRect.width ?? 0) < 960)); observer.observe(el); return () => observer.disconnect(); },[host]);
  useEffect(() => { if (open && mounted && !narrow) surface.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(); },[open,mounted,narrow]);
  if (narrow) return <Modal open={open} onClose={onClose} className="vc-commit-mobile" overlayClassName="vc-commit-overlay" animation="fade" ariaLabel="本次提交">{children}</Modal>;
  return mounted ? <aside ref={surface} className="vc-commit-drawer" aria-label="本次提交区域" data-state={entered ? "open" : "closed"} data-exiting={!open || undefined} {...(!open ? {inert:""} : {})}>{children}</aside> : null;
}
