import { Modal } from "../ui/Modal";
import { UpdateDialogContent } from "./UpdateDialogContent";
import type { UpdateDialogProcess } from "./UpdateProcess";
import { APP_INFO } from "../../lib/about";
import type { UpdateNotesInfo } from "../../lib/updateNotes";

/** 更新下载行为沿用现有通道；展示层单独解析版本范围。 */
export function UpdateNotesDialog({ open, update, process, onClose, onDownload, onDismiss, onRestart, onRetry }: {
  open: boolean;
  update: UpdateNotesInfo | null;
  process?: UpdateDialogProcess;
  onClose: () => void;
  onDownload: () => void;
  onDismiss: () => void;
  onRestart?: () => void;
  onRetry?: () => void;
}) {
  if (!update && !process) return null;
  const close = () => { if (!process?.preparing && !process?.restarting && process?.status !== "installing") onClose(); };
  return <Modal open={open} onClose={close} zIndex={1000} ariaLabel={`${APP_INFO.name} 软件更新`} className="modal-surface update-dialog">
    <UpdateDialogContent key={`${update?.currentVersion ?? ""}/${update?.version ?? ""}`} update={update} process={process} onClose={close} onDownload={onDownload} onDismiss={onDismiss} onRestart={onRestart} onRetry={onRetry} />
  </Modal>;
}
