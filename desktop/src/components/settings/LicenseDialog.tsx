import { LICENSE_TEXT } from "../../lib/license";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import "./settings-about.css";

export function LicenseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Modal open={open} onClose={onClose} ariaLabel="MIT 许可" className="modal-surface settings-about-dialog">
    <header className="settings-about-dialog-head"><h2>MIT License</h2>
      <Button variant="ghost" size="icon" aria-label="关闭许可" onClick={onClose}><Icon name="close" size={16} /></Button></header>
    <pre className="settings-about-license-text" tabIndex={0}>{LICENSE_TEXT}</pre>
    <footer className="settings-about-dialog-foot"><span>项目许可证 · LICENSE</span><Button variant="outline" size="sm" onClick={onClose}>关闭</Button></footer>
  </Modal>;
}
