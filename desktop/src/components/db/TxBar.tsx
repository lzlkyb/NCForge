import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { friendlyDbError, parseDbError, thousands } from "../../lib/db";
import { reconnectSession } from "../../lib/dbConfirm";
import { useAppHidden } from "../../lib/appVisibility";
import { type TxInfo } from "../../lib/dbApi";
import { patchTab, txAction, useConnRt, type SqlTab } from "../../lib/dbStore";

function since(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/**
 * 手动提交模式下有未提交的写语句时：黄条显示几条 / 几行 / 多久，点提交或回滚。
 *
 * **槽各自独立事务**（A0）：SQL 标签跑在自己的会话槽里，所以带 `slot` 时看的是
 * `tab.tx`、提交/回滚也发到那条槽上；不带 `slot` 的是 primary（表页 / 元数据那条会话）。
 * 只显示 primary 的事务条会让人以为「没有未提交的改动」，而槽里正压着一条 update。
 */
export function TxBar({ connId, tabId, slot, tx: override }: {
  connId: string | null;
  /** 槽级事务操作完成后要把结果写回标签（只有 SQL 标签有）。 */
  tabId?: string;
  slot?: string | null;
  /** 槽的事务状态；primary 不传（统一看连接的 `rt.tx`）。 */
  tx?: TxInfo;
}) {
  const primaryTx = useConnRt(connId).tx;
  // 独立槽刚创建时状态尚未知；不能把另一条主会话的未提交写入显示为它的事务。
  const tx = slot ? override : primaryTx;
  const [, tick] = useState(0);
  /** 正在提交 / 回滚哪一边：大事务要好几秒，只把按钮置灰看不出点没点上。 */
  const [acting, setActing] = useState<null | "commit" | "rollback" | "reconnect">(null);
  const [lostSession, setLostSession] = useState<string | null>(null);
  const session = `${connId}:${slot ?? ""}`;
  const actionLock = useRef(false);
  const appHidden = useAppHidden();
  const open = !!tx && !tx.autoCommit && tx.statements > 0;
  // 持续时间每秒刷新；窗口不可见时不刷（CLAUDE.md 8.1：不可见必须停轮询）
  useEffect(() => {
    if (!open || appHidden) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open, appHidden]);
  if (!open || !connId) return null;

  const act = async (a: "commit" | "rollback" | "reconnect") => {
    if (actionLock.current) return;
    actionLock.current = true;
    setActing(a);
    try {
      if (a === "reconnect") {
        if (await reconnectSession(connId, slot ?? null, tabId)) setLostSession(null);
        return;
      } else if (slot && tabId) {
        const tx = await txAction(connId, a, slot);
        patchTab<SqlTab>(tabId, { tx });
      } else {
        await txAction(connId, a);
      }
      toast(a === "commit" ? "已提交" : "已回滚", "success");
    } catch (e) {
      if (parseDbError(e).code === "session-lost") setLostSession(session);
      const label = a === "commit" ? "提交" : a === "rollback" ? "回滚" : "重连";
      toast(`${label}失败：${friendlyDbError(e)}`, "error");
    } finally {
      actionLock.current = false;
      setActing(null);
    }
  };

  if (lostSession === session) return (
    <div className="dbx-txbar" role="status">
      <Icon name="alertTriangle" size={14} />
      <span>数据库会话已断开，事务结果需核对。</span>
      <span className="dbx-sp" />
      <button type="button" className="dbx-btn" disabled={acting !== null} onClick={() => void act("reconnect")}>
        {acting === "reconnect" ? "正在重新连接…" : "重新连接"}
      </button>
    </div>
  );

  return (
    <div className="dbx-txbar" role="status">
      <Icon name="alertTriangle" size={14} />
      <span>
        未提交事务：<b>{tx.statements}</b> 条写语句 · 影响 <b>{thousands(tx.rows)}</b> 行
        {tx.since > 0 && <> · 已持续 {since(tx.since)}</>}
        {slot && <span className="dbx-tx-session" title={`独立会话 ${slot}，与其它标签各自独立`}> · 独立事务</span>}
      </span>
      <span className="dbx-sp" />
      <button type="button" className="dbx-btn" disabled={acting !== null} onClick={() => void act("rollback")}>
        <Icon name={acting === "rollback" ? "spinner" : "refresh"} size={12} />
        {acting === "rollback" ? "回滚中…" : "回滚"}
      </button>
      <button type="button" className="dbx-btn ok" disabled={acting !== null} onClick={() => void act("commit")}>
        <Icon name={acting === "commit" ? "spinner" : "check"} size={12} />
        {acting === "commit" ? "提交中…" : "提交"}
      </button>
    </div>
  );
}
