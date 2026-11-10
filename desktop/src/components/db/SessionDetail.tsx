import { CodePreview } from "./CodePreview";
import { Modal } from "../ui/Modal";
import type { SessionRow } from "../../lib/dbApi";

/**
 * 选中会话的详情快照。不随后台刷新替换：面板每 10 秒重读一次，如果详情跟着变，
 * 用户刚点开的那条 SQL 会在阅读时被换掉。沿阻塞 SID 查看时跟随当前列表里的行。
 */
export function SessionDetail({ selected, rows, connId, onSelect, onClose }: {
  selected: SessionRow;
  rows: SessionRow[] | null;
  connId: string;
  onSelect: (row: SessionRow) => void;
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} className="modal-surface dbx-dlg" ariaLabel={`会话 ${selected.sid} 详情`}>
      <div className="hd">会话 {selected.sid}<span className="dbx-sp"/><button type="button" className="dbx-btn" onClick={onClose}>关闭会话详情</button></div>
      <div className="bd one"><p>{selected.user} · {selected.machine} · {selected.program}</p><p>{selected.status} · 等待：{selected.event || "无"} · 选中时快照，不随后台刷新替换</p>
      {selected.blocker != null && <p>被 SID {selected.blocker} 阻塞。{rows?.find(row=>row.sid===selected.blocker) ? <button type="button" className="dbx-lk" onClick={()=>onSelect(rows!.find(row=>row.sid===selected.blocker)!)}>查看阻塞会话</button> : "阻塞者不在当前可见会话列表中。"}</p>}
      {selected.locked.length>0 && <p>锁定对象：{selected.locked.join("、")}</p>}
      {selected.sql ? <CodePreview text={selected.sql} label="会话 SQL" connId={connId}/> : <p>{selected.sqlId ? `SQL文本不可见，SQL ID：${selected.sqlId}` : "没有可用SQL文本"}</p>}
      </div>
    </Modal>
  );
}
