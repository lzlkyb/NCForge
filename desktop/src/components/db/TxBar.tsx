import { useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import { friendlyDbError, parseDbError, thousands } from "../../lib/db";
import { reconnectSession } from "../../lib/dbConfirm";
import { dbTaskSpec, dbTxKey } from "../../lib/dbOperations";
import { getOperations, operationActive, subscribeOperations, trackOperation } from "../../lib/operations";
import { patchTab, setTx, setTxNotice, sqlTabOf, txAction, useConnOf, useConnRt, type SqlTab } from "../../lib/dbStore";
import { dbApi, type TxInfo } from "../../lib/dbApi";

type TxTarget = {
  connId: string | null;
  tabId?: string;
  slot?: string | null;
  tx?: TxInfo;
  notice?: SqlTab["txNotice"];
  blocked?: boolean;
  readOnly?: boolean | null;
};

export function useDbTransaction({ connId, tabId, slot, tx: slotTx, notice: slotNotice, blocked, readOnly }: TxTarget) {
  const conn = useConnOf(connId);
  const rt = useConnRt(connId);
  const tx = slot ? slotTx : rt.tx;
  const notice = slot ? slotNotice : rt.txNotice;
  const key = dbTxKey(connId, slot);
  const active = useSyncExternalStore(subscribeOperations, () =>
    getOperations().find(op => op.key === 'db.' + key && op.endedAt === undefined));
  const pending = !!tx && !tx.autoCommit && tx.statements > 0;
  const lost = notice?.kind === "lost";
  const modeChanged = !readOnly && !!conn && !!tx && tx.autoCommit !== conn.autoCommit;
  const connected = rt.status === "connected";
  const disabled = !connected || !!active || !!blocked || !!readOnly || !pending || lost;
  const canReconnect = connected && !active && !blocked && (lost || modeChanged && !pending);

  const act = async (action: "commit" | "rollback" | "reconnect") => {
    if (!connId || operationActive('db.' + key) || (action === "reconnect" ? !canReconnect : disabled)) return;
    const label = action === "commit" ? "提交" : action === "rollback" ? "回滚" : notice?.verify ? "核对事务" : "重新连接";
    const applySlotTx = (next: TxInfo) => {
      const tab = sqlTabOf(tabId);
      if (slot && tab && tab.connId === connId && tab.slot === slot) patchTab<SqlTab>(tab.id, {tx:next});
    };
    try {
      if (action === "reconnect" && notice?.verify) {
        const status = await trackOperation(dbTaskSpec(key,label,connId,slot ? "独立会话" : "主会话",conn?.name,tabId),
          () => dbApi.tx(connId,"status",slot));
        if (status.alive === false) throw new Error("session-lost|数据库会话已断开");
        if (slot) applySlotTx(status.tx);
        else setTx(connId,status.tx);
        setTxNotice(connId,slot,tabId,{kind:"success",text:"事务状态已刷新 · 请核对上一次写入结果"});
      } else if (action === "reconnect") {
        const ok = await trackOperation(dbTaskSpec(key,"重新连接",connId,slot ? "独立会话" : "主会话",conn?.name,tabId),
          () => reconnectSession(connId, slot ?? null, tabId, false, !lost),
          value => ({state:value ? "success" : "cancelled"}));
        if (ok) setTxNotice(connId, slot, tabId, {kind:"success",text:"已重新连接 · 连接设置已生效"});
      } else {
        const next = await txAction(connId, action, slot);
        applySlotTx(next);
        setTxNotice(connId, slot, tabId, {kind:"success",text:'已' + label + ' · ' + thousands(tx?.rows ?? 0) + ' 行'});
      }
    } catch (error) {
      const code = parseDbError(error).code;
      const unknown = lost || code === "session-lost" || action !== "reconnect" && code === "bridge";
      setTxNotice(connId, slot, tabId, unknown
        ? {kind:"lost",verify:code !== "session-lost" && (notice?.verify || action !== "reconnect" && code === "bridge"),
            text:action === "reconnect" ? label + '失败 · ' + friendlyDbError(error) : label + '结果待核对 · 数据库未返回确认'}
        : {kind:"error",text:label + '失败 · ' + friendlyDbError(error)});
    }
  };

  return { tx, slot, pending, notice, lost, active, disabled, canReconnect, modeChanged, connected, act,
    mode: readOnly ? "只读查询" : tx ? tx.autoCommit ? "自动提交" : "手动提交" : undefined };
}

type Transaction = ReturnType<typeof useDbTransaction>;

export function TransactionButtons({ transaction: t }: { transaction: Transaction }) {
  const title = t.lost ? "当前会话的事务结果待核对" : t.mode === "自动提交" ? "当前会话使用自动提交"
    : t.pending ? "处理当前会话的事务" : "当前会话没有待提交的写入";
  return <div className="dbx-tx-actions" role="group" aria-label="当前会话事务">
    <button type="button" className={t.disabled ? "dbx-btn" : "dbx-btn ok"} title={title}
      disabled={t.disabled} aria-busy={t.active?.label === "提交事务"} onClick={() => void t.act("commit")}>
      <Icon name={t.active?.label === "提交事务" ? "clock" : "check"} size={12} />
      {t.active?.label === "提交事务" ? "提交中…" : "提交"}
    </button>
    <button type="button" className="dbx-btn" title={title}
      disabled={t.disabled} aria-busy={t.active?.label === "回滚事务"} onClick={() => void t.act("rollback")}>
      <Icon name={t.active?.label === "回滚事务" ? "clock" : "stepOut"} size={12} />
      {t.active?.label === "回滚事务" ? "回滚中…" : "回滚"}
    </button>
  </div>;
}

export function TxBar({ transaction: t }: { transaction: Transaction }) {
  const tone = t.active ? "busy" : t.lost || t.notice?.kind === "error" ? "bad"
    : t.pending || t.modeChanged ? "warn" : "ok";
  if (!t.active && !t.notice && !t.pending && !t.modeChanged) return null;
  return <div className="dbx-txbar" data-tone={tone} role="status">
    <Icon name={tone === "busy" ? "clock" : tone === "ok" ? "check" : "alertTriangle"} size={14} />
    {t.active ? <span>{t.active.label}中…等待数据库确认</span> : <>
      {t.notice && <span>{t.notice.text}</span>}
      {!t.lost && t.pending && <span>未提交事务 · <b>{t.tx?.statements}</b> 条写入 · 影响 <b>{thousands(t.tx?.rows ?? 0)}</b> 行</span>}
      {!t.lost && t.modeChanged && <span>{t.pending ? "提交方式已更新 · 处理事务后可重连" : "提交方式已更新 · 重连后生效"}</span>}
    </>}
    {(t.lost || t.modeChanged) && <button type="button" className="dbx-btn" disabled={!t.canReconnect} onClick={() => void t.act("reconnect")}>{t.notice?.verify ? "核对事务" : "重新连接"}</button>}
  </div>;
}
