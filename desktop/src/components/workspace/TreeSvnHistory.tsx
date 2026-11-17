import { baseName } from "../../lib/workspace";
import { HistoryView } from "../svn/HistoryView";
import { Modal } from "../ui/Modal";

export default function TreeSvnHistory({ path, revision, onClose }: { path: string; revision: number; onClose: () => void }) {
  return <Modal open onClose={onClose} ariaLabel="文件 SVN 提交历史"
    className="modal-surface flex h-[min(680px,85vh)] w-[var(--w-modal-xl)] flex-col overflow-hidden rounded-[var(--r-card)]">
    <HistoryView path={path} title={baseName(path)} initialRevision={revision} backLabel="关闭" onBack={onClose} />
  </Modal>;
}
