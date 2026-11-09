import { useRef, useState, type ReactNode } from "react";
import { dbApi, ENV_LABEL } from "../../lib/dbApi";
import { claimCursor, getDb, patchTab, setTx, useConnOf, useConnRt, type SqlTab } from "../../lib/dbStore";
import { toast } from "../ui/toast";
import { friendlyDbError } from "../../lib/db";

import { trackOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { Icon } from "../ui/icon";
import { useDbReadOnly } from "../../lib/dbReadOnly";
import { SchemaChip } from "./SchemaChip";
import { ConnectionStatus } from "./ConnectionStatus";

export function DbContextBar({ connId, independent = false, connectionControl, transactionMode, sessionControl, compact = false }: {
  compact?: boolean; connId: string | null; independent?: boolean; connectionControl?: ReactNode; transactionMode?: string; sessionControl?: ReactNode;
}) {
  const conn = useConnOf(connId), rt = useConnRt(connId);
  const readOnly = useDbReadOnly(connId); const [busy,setBusy] = useState(false); const lock=useRef(false);
  const toggle = async () => {
    if (!connId || lock.current) return;
    lock.current=true;setBusy(true);
    try { const v = await trackOperation(dbTaskSpec(`readonly:${connId}`,"切换只读查询",connId,"全部会话",conn?.name),()=>dbApi.readOnly(connId,!readOnly)); setTx(connId,v.tx); claimCursor(connId,null,"readonly-toggle"); toast(v.readOnly?"已开启只读查询，续取结果请重新执行":"已关闭只读查询","success"); for(const tab of getDb().tabs) {if(tab.kind==="sql" && tab.connId===connId && tab.slot) {claimCursor(connId,tab.slot,"readonly-toggle"); void dbApi.tx(connId,"status",tab.slot).then(r=>patchTab<SqlTab>(tab.id,{tx:r.tx}),()=>{});}} window.dispatchEvent(new CustomEvent("ncforge-db-readonly",{detail:{id:connId,...v}})); }
    catch(e) { toast(friendlyDbError(e),"error"); }
    finally { lock.current=false;setBusy(false); }
  };
  return <div className="dbx-context" data-prod={conn?.env === "prod" || undefined}>
    <span className="dbx-context-connection">{connectionControl ?? (conn ? <strong title={conn.name}>{conn.name}</strong> : <span>未选择数据库连接</span>)}</span>
    {conn && <span className="dbx-context-env" title={conn.env === "prod" ? "生产环境：写操作需要确认" : undefined}>{ENV_LABEL[conn.env]}</span>}
    {/* 默认 schema 就挂在上下文这一行：它和「哪个库、哪个账号」是同一层的会话属性，
        放在执行按钮旁边会让人以为是每条语句的选项。 */}
    <SchemaChip connId={connId} />
    <ConnectionStatus status={rt.status} />
    <span className="dbx-context-session">{sessionControl ?? `${independent ? "独立会话" : "共享会话"} · ${readOnly ? "只读查询" : transactionMode ?? "状态待确认"}`}</span>
    <button type="button" className="dbx-btn ghost dbx-connection-readonly" disabled={busy || rt.status !== "connected" || readOnly === null} aria-pressed={readOnly ?? false} aria-label={`连接只读：${readOnly ? "开启" : "关闭"}（此连接全部会话）`} title={`连接只读：${readOnly ? "开启" : "关闭"} · 应用于此连接全部会话`} onClick={() => void toggle()}>
      <Icon name={busy ? "spinner" : "lock"} size={12} />
      <span hidden={compact}>连接只读：{busy ? "切换中…" : readOnly === null ? "待验证" : readOnly ? "开启" : "关闭"}<small>此连接全部会话</small></span>
    </button>
    {conn && rt.status === "connected" && <details className="dbx-connection-detail">
      <summary aria-label="连接详情" title="账号、地址和连接设置"><Icon name="info" size={14} /></summary>
      <div className="dbx-connection-detail-body">
        <span>账号 · {conn.user}</span>
        <span>地址 · {conn.url}</span>
        <span>当前会话 · {readOnly ? "只读查询" : transactionMode ?? "待确认"}</span>
        <span>连接设置 · {conn.autoCommit ? "自动提交" : "手动提交"}{conn.noStmtCache && conn.engine === "rust" ? " · 无语句缓存" : ""}</span>
        <span>连接只读作用于此连接全部会话；账号权限由数据库配置。</span>
        <span>只读查询使用 Oracle 只读事务并限制执行语句；具有自治事务的函数仍须使用只读账号限制。</span>
      </div>
    </details>}
  </div>;
}
