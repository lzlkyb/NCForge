import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { logsRaw, type LogRecord } from "../../lib/serverLog";

export function ServiceLogDetails({ record, onClose, onCopy }: { record: LogRecord | null; onClose: () => void; onCopy: (text: string, label: string) => void }) {
  return <Modal open={record !== null} onClose={onClose} className="modal-surface sc-log-dialog" ariaLabel="完整异常原文">
    <div className="sc-log-dialog-head"><strong>完整异常</strong><button type="button" className="sc-log-icon" aria-label="关闭完整异常" onClick={onClose}><Icon name="close" size={15} /></button></div>
    {record && <><p className="sc-log-root">{record.rootCause || record.line.text}</p><pre>{logsRaw([record.line, ...record.stack])}</pre><div className="sc-log-dialog-actions"><button type="button" className="sc-log-button" onClick={() => onCopy(logsRaw([record.line, ...record.stack]), "异常原文")}><Icon name="copy" size={13} />复制异常原文</button><button type="button" className="sc-log-button" onClick={onClose}>关闭</button></div></>}
  </Modal>;
}
