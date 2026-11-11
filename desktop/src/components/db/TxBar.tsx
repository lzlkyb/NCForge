import { useState, useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { friendlyDbError, parseDbError, thousands } from "../../lib/db";
import { reconnectSession } from "../../lib/dbConfirm";
import { dbTaskSpec, dbTxKey } from "../../lib/dbOperations";
import { getOperations, operationActive, subscribeOperations, trackOperation } from "../../lib/operations";
import { patchTab, setTx, setTxNotice, sqlTabOf, txAction, useConnOf, useConnRt, type SqlTab } from "../../lib/dbStore";
import { dbApi, type TxInfo } from "../../lib/dbApi";
import { bumpTxEpoch } from "../../lib/dbTxEpoch";
import { txPending } from "../../lib/txState";
import { ContextMenu } from "../workspace/ContextMenu";

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
  // 真源优先：`v$transaction` 说没有事务时，本地那条脏计数不再算数。
  const { pending, dbConfirmed } = txPending(tx);
  const dbNoTx = dbConfirmed === false;
  const lost = notice?.kind === "lost";
  const modeChanged = !readOnly && !!conn && !!tx && tx.autoCommit !== conn.autoCommit;
  const connected = rt.status === "connected";
  const disabled = !connected || !!active || !!blocked || !!readOnly || !pending || lost;
  const canReconnect = connected && !active && !blocked && (lost || dbNoTx || modeChanged && !pending);

  const act = async (action: "commit" | "rollback" | "reconnect") => {
    if (!connId || operationActive('db.' + key) || (action === "reconnect" ? !canReconnect : disabled)) return;
    const label = action === "commit" ? "提交" : action === "rollback" ? "回滚" : notice?.verify ? "核对事务" : "重新连接";
    const applySlotTx = (next: TxInfo) => {
      const tab = sqlTabOf(tabId);
      if (slot && tab && tab.connId === connId && tab.slot === slot) patchTab<SqlTab>(tab.id, {tx:next});
    };
    /**
     * 成功不是「状态」，是「刚发生的一件事」：说一声就收，别在事务条上常驻。
     *
     * 常驻横幅一挂就是「已提交 · 3 行」，用户过一会儿回来只看到一个勾，会以为
     * 还有一笔事务没处理；真正要看的「有没有未提交事务」反而被这行盖住了。
     * 常驻条只留给需要动手的状态（未提交 / 结果待核对 / 待重连 / 失败）。
     */
    const done = (text: string) => {
      setTxNotice(connId, slot, tabId, undefined);
      toast(text, "success");
    };
    try {
      if (action === "reconnect" && notice?.verify) {
        const status = await trackOperation(dbTaskSpec(key,label,connId,slot ? "独立会话" : "主会话",conn?.name,tabId),
          () => dbApi.tx(connId,"status",slot));
        if (status.alive === false) throw new Error("session-lost|数据库会话已断开");
        if (slot) applySlotTx(status.tx);
        else setTx(connId,status.tx);
        const verdict = status.active === true ? "数据库确认有未提交事务"
          : status.active === false ? "数据库确认没有未提交事务"
          : "字典不可读，按本地记录核对";
        done(`事务状态已刷新 · ${verdict}`);
      } else if (action === "reconnect") {
        const ok = await trackOperation(dbTaskSpec(key,"重新连接",connId,slot ? "独立会话" : "主会话",conn?.name,tabId),
          () => reconnectSession(connId, slot ?? null, tabId, false, !lost),
          value => ({state:value ? "success" : "cancelled"}));
        if (ok) done("已重新连接 · 连接设置已生效");
      } else {
        const next = await txAction(connId, action, slot);
        applySlotTx(next);
        // 通知网格：回滚后本地覆盖的「已写回」值不再成立，表页要重新读。
        bumpTxEpoch(connId, slot, action);
        done('已' + label + ' · ' + thousands(tx?.rows ?? 0) + ' 行');
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

  return { tx, slot, pending, dbConfirmed, notice, lost, active, disabled, canReconnect, modeChanged, connected, blocked, act,
    mode: readOnly ? "只读查询" : tx ? tx.autoCommit ? "自动提交" : "手动提交" : undefined };
}

type Transaction = ReturnType<typeof useDbTransaction>;

function transactionReason(t: Transaction) {
  return !t.connected ? "当前连接尚未建立" : t.lost ? "当前会话的事务结果待核对"
    : t.active ? `${t.active.label}中，等待数据库确认` : t.blocked ? "正在执行 SQL，等待返回后处理事务"
    : t.mode === "只读查询" ? "当前连接全部会话使用只读查询" : t.mode === "自动提交" ? "当前会话使用自动提交"
    : t.pending ? (t.dbConfirmed === true ? "数据库确认当前会话有未提交事务" : "处理当前会话的事务")
    : t.dbConfirmed === false ? "数据库确认当前会话没有未提交事务"
    : "当前会话没有待提交的写入";
}

export function TransactionMenu({ transaction: t, compact = false }: { transaction: Transaction; compact?: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const label = `${t.slot ? "独立会话" : "共享会话"} · ${t.mode ?? "状态待确认"}`;
  return <>
    <button type="button" className="dbx-btn ghost dbx-session-trigger" title={label} aria-label={`当前会话：${label}`} aria-haspopup="menu" aria-expanded={!!menu} onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ x: rect.left, y: rect.bottom + 4 });
    }}>
      {compact && <Icon name="database" size={14} />}<span>{compact ? t.mode ?? "状态待确认" : label}</span><Icon name="chevronDown" size={12} />
    </button>
    {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} items={[
      { label: transactionReason(t), disabled: true, onSelect: () => {} },
      { label: "提交", icon: "check", disabled: t.disabled, onSelect: () => void t.act("commit") },
      { label: "回滚", icon: "rollback", disabled: t.disabled, onSelect: () => void t.act("rollback") },
      ...((t.lost || t.modeChanged) ? [{ label: t.notice?.verify ? "核对事务" : "重新连接", icon: "refresh" as const, disabled: !t.canReconnect, onSelect: () => void t.act("reconnect") }] : []),
    ]} />}
  </>;
}

export function TransactionButtons({ transaction: t, compact = false }: { transaction: Transaction; compact?: boolean }) {
  const title = transactionReason(t);
  return <div className="dbx-tx-actions" data-compact={compact || undefined} role="group" aria-label="当前会话事务">
    <button type="button" className={t.disabled ? "dbx-btn" : "dbx-btn ok"} title={`提交当前会话 · ${title}`} aria-label={t.active?.label === "提交事务" ? "提交中…" : "提交当前会话"}
      disabled={t.disabled} aria-busy={t.active?.label === "提交事务"} onClick={() => void t.act("commit")}>
      <Icon name={t.active?.label === "提交事务" ? "clock" : "check"} size={12} />
      {!compact && (t.active?.label === "提交事务" ? "提交中…" : "提交当前会话")}
    </button>
    <button type="button" className="dbx-btn" title={`回滚当前会话 · ${title}`} aria-label={t.active?.label === "回滚事务" ? "回滚中…" : "回滚当前会话"}
      disabled={t.disabled} aria-busy={t.active?.label === "回滚事务"} onClick={() => void t.act("rollback")}>
      <Icon name={t.active?.label === "回滚事务" ? "clock" : "rollback"} size={12} />
      {!compact && (t.active?.label === "回滚事务" ? "回滚中…" : "回滚当前会话")}
    </button>
  </div>;
}

export function TxBar({ transaction: t, actions = false }: { transaction: Transaction; actions?: boolean }) {
  // 只在「有事要处理」时出现：处理中 / 未提交 / 结果待核对 / 待重连 / 失败。
  // 事务已经结束（提交、回滚、核对确认没有）就不该再挂一行——那是状态，不是待办。
  if (!t.active && !t.notice && !t.pending && !t.modeChanged) return null;
  const tone = t.active ? "busy" : (t.lost || t.notice) ? "bad" : "warn";
  return <div className="dbx-txbar" data-tone={tone} role="status">
    <Icon name={tone === "busy" ? "clock" : "alertTriangle"} size={14} />
    {actions && <span className="dbx-tx-owner">{t.slot ? "独立会话" : "共享会话"}</span>}
    {t.active ? <span>{t.active.label}中…等待数据库确认</span> : <>
      {t.notice && <span>{t.notice.text}</span>}
      {!t.lost && t.pending && <span>
        {t.dbConfirmed === true ? "数据库确认：有未提交事务" : "未提交事务"}
        {/* 核对过但本地计数为 0（手写 PL/SQL 内部提交、别的工具写过同一条会话）：
            写「0 条写入」只会让人以为搞错了，不如直说要处理事务。 */}
        {(t.tx?.statements ?? 0) > 0
          ? <> · <b>{t.tx?.statements}</b> 条写入 · 影响 <b>{thousands(t.tx?.rows ?? 0)}</b> 行</>
          : <span className="dbx-muted"> · 提交或回滚后此条消失</span>}
      </span>}
      {!t.lost && t.modeChanged && <span>{t.pending ? "提交方式已更新 · 处理事务后可重连" : "提交方式已更新 · 重连后生效"}</span>}
    </>}
    {actions && !t.lost && (t.pending || t.active) && <TransactionButtons transaction={t} />}
    {(t.lost || t.modeChanged) && <button type="button" className="dbx-btn" disabled={!t.canReconnect} onClick={() => void t.act("reconnect")}>{t.notice?.verify ? "核对事务" : "重新连接"}</button>}
  </div>;
}
