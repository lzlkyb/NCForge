import { useRef, type ReactNode } from "react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useViewActive } from "../../lib/viewActivity";
import { Icon } from "../ui/icon";

/** 停靠与抽屉共用同一棵内容树；窗口缩放不会卸载正在填写的编辑表单。 */
export function MetaPanel({ children, side, label, drawer, open, onClose }: {
  children: ReactNode; side: "resource" | "inspector"; label: string; drawer: boolean; open: boolean; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useViewActive();
  const visible = drawer && open && active;
  useFocusTrap(ref, { enabled: visible, onEscape: onClose });
  return <>
    {visible && <div className={`meta-drawer-backdrop meta-${side}-backdrop`} onClick={onClose} aria-hidden="true" />}
    <div ref={ref} className={`meta-panel meta-${side}-panel ${drawer ? "is-drawer" : ""}`}
      hidden={drawer && !visible} role={visible ? "dialog" : "region"}
      aria-modal={visible || undefined} aria-label={label}>
      {drawer && <div className="meta-drawer-head"><strong>{label}</strong>
        <button type="button" className="meta-icon-button" onClick={onClose} aria-label={`收起${label}`}><Icon name="close" size={15} /></button>
      </div>}
      {children}
    </div>
  </>;
}
