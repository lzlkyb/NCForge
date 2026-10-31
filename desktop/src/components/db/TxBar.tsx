import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { friendlyDbError, thousands } from "../../lib/db";
import { dbApi, type TxInfo } from "../../lib/dbApi";
import { patchTab, rtOf, txAction, useDb, type SqlTab } from "../../lib/dbStore";

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
  useDb();
  const tx = override ?? rtOf(connId).tx;
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(false);
  const open = !!tx && !tx.autoCommit && tx.statements > 0;
  // 持续时间每秒刷新
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open]);
  if (!open || !connId) return null;

  const act = async (a: "commit" | "rollback") => {
    setBusy(true);
    try {
      if (slot && tabId) {
        const r = await dbApi.tx(connId, a, slot);
        patchTab<SqlTab>(tabId, { tx: r.tx });
      } else {
        await txAction(connId, a);
      }
      toast(a === "commit" ? "已提交" : "已回滚", "success");
    } catch (e) {
      toast(`${a === "commit" ? "提交" : "回滚"}失败：${friendlyDbError(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dbx-txbar" role="status">
      <Icon name="alertTriangle" size={14} />
      <span>
        未提交事务：<b>{tx.statements}</b> 条写语句 · 影响 <b>{thousands(tx.rows)}</b> 行
        {tx.since > 0 && <> · 已持续 {since(tx.since)}</>}
        {slot && <span className="dbx-muted">（独立会话 {slot}，与其它标签各自独立）</span>}
      </span>
      <span className="dbx-sp" />
      <button type="button" className="dbx-btn" disabled={busy} onClick={() => void act("rollback")}>
        <Icon name="refresh" size={12} />
        回滚
      </button>
      <button type="button" className="dbx-btn ok" disabled={busy} onClick={() => void act("commit")}>
        <Icon name="check" size={12} />
        提交
      </button>
    </div>
  );
}
