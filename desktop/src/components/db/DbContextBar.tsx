import { useRef, useState, type ReactNode } from "react";
import { dbApi, dbNameOf, ENV_LABEL } from "../../lib/dbApi";
import { claimCursor, getDb, patchTab, setTx, useConnOf, useConnRt, type SqlTab } from "../../lib/dbStore";
import { toast } from "../ui/toast";
import { friendlyDbError } from "../../lib/db";

import { trackOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { Icon } from "../ui/icon";
import { useDbReadOnly } from "../../lib/dbReadOnly";
import { SchemaChip } from "./SchemaChip";

export function DbContextBar({ connId, independent = false, connectionControl }: { connId: string | null; independent?: boolean; connectionControl?: ReactNode }) {
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
    {connectionControl ?? (conn ? <strong title={conn.name}>{conn.name}</strong> : <span>未选择数据库连接</span>)}
    {conn && <><span className="dbx-context-env" title={conn.env === "prod" ? "生产环境：写操作需要确认" : undefined}>{ENV_LABEL[conn.env]}</span><span className="dbx-context-account" title={`${conn.user}@${conn.url}`}>{conn.user}@{dbNameOf(conn.url)}</span></>}
    {/* 默认 schema 就挂在上下文这一行：它和「哪个库、哪个账号」是同一层的会话属性，
        放在执行按钮旁边会让人以为是每条语句的选项。 */}
    <SchemaChip connId={connId} />
    <span className="dbx-context-status" data-connected={rt.status === "connected" || undefined}>{rt.status === "connected" ? "已连接" : rt.status === "connecting" ? <><Icon name="spinner" size={12} />连接中…</> : rt.status === "error" ? "连接失败" : "未连接"}</span>
    <span title="只读查询模式使用 Oracle 只读事务并限制执行语句。账号权限仍由数据库配置；具有自治事务的函数须使用只读账号限制。" className="dbx-context-session">{independent ? "独立事务" : "共享事务"}</span>
    <button type="button" className="dbx-btn ghost" disabled={busy || rt.status !== "connected" || readOnly === null} aria-pressed={readOnly ?? false} title="只读模式应用于此连接的全部会话" onClick={() => void toggle()}><Icon name={busy ? "spinner" : "lock"} size={12} />{busy ? "切换中…" : readOnly === null && rt.status === "connected" ? "只读状态待验证" : readOnly ? "只读查询已开启" : "开启只读查询"}</button>
  </div>;
}
