import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { friendlyDbError, thousands } from "../../lib/db";
import { rtOf, txAction, useDb } from "../../lib/dbStore";

function since(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 手动提交模式下有未提交的写语句时：黄条显示几条 / 几行 / 多久，点提交或回滚。 */
export function TxBar({ connId }: { connId: string | null }) {
  useDb();
  const tx = rtOf(connId).tx;
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
      await txAction(connId, a);
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
