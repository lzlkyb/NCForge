import { Modal } from "../ui/Modal";
import { connOf, rtOf, useDbSelector } from "../../lib/dbStore";
import { ENV_LABEL } from "../../lib/dbApi";
import { thousands } from "../../lib/db";
import { txPending } from "../../lib/txState";

/** 没有主会话标签时只展示概况，不能为了定位而新建一条独立 SQL 会话。 */
export function PrimarySessionSummary({ connId, onClose }: { connId: string; onClose: () => void }) {
  const tx = useDbSelector(() => rtOf(connId).tx);
  const conn = connOf(connId);
  // 判据与事务条、状态栏同一条（`txPending`）：核对过就以 `v$transaction` 为准。
  // 只看 `statements` 会在「数据库确认有事务、本地计数为 0」时谎报「没有未提交的写入」。
  const pending = txPending(tx).pending;
  return (
    <Modal open onClose={onClose} ariaLabel="主会话事务" className="modal-surface w-[420px] max-w-[calc(100vw-32px)] p-5">
      <h2 className="text-base font-semibold">主会话事务</h2>
      <p className="mt-2 text-sm text-muted-foreground">{conn?.name ?? "数据库"}{conn && ` · ${ENV_LABEL[conn.env]}`}</p>
      <p className="mt-3 text-sm">{pending
        ? `${(tx?.statements ?? 0) > 0 ? `${tx!.statements} 条写语句未提交 · 影响 ${thousands(tx!.rows)} 行` : "数据库确认有未提交事务（本地没有记录到写入）"}`
        : "当前主会话没有未提交的写入。"}</p>
      <p className="mt-2 text-sm text-muted-foreground">主会话供表页和元数据操作使用。独立 SQL 标签有各自的事务，需分别处理。可从该连接的表页查看主会话的提交与回滚入口。</p>
      <button type="button" className="dbx-btn mt-4" onClick={onClose}>关闭</button>
    </Modal>
  );
}
