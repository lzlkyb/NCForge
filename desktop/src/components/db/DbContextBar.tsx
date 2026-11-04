import { useRef, useState } from "react";
import { dbApi, dbNameOf, ENV_LABEL } from "../../lib/dbApi";
import { claimCursor, connOf, getDb, patchTab, rtOf, setTx, useDb, type SqlTab } from "../../lib/dbStore";
import { toast } from "../ui/toast";
import { friendlyDbError } from "../../lib/db";

import { trackOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { Icon } from "../ui/icon";
import { useDbReadOnly } from "../../lib/dbReadOnly";

export function DbContextBar({ connId, independent = false }: { connId: string | null; independent?: boolean }) {
  useDb();
  const conn = connOf(connId), rt = rtOf(connId);
  const readOnly = useDbReadOnly(connId); const [busy,setBusy] = useState(false); const lock=useRef(false);
  const toggle = async () => {
    if (!connId || lock.current) return;
    lock.current=true;setBusy(true);
    try { const v = await trackOperation(dbTaskSpec(`readonly:${connId}`,"切换只读查询",connId,"全部会话",conn?.name),()=>dbApi.readOnly(connId,!readOnly)); setTx(connId,v.tx); claimCursor(connId,null,"readonly-toggle"); toast(v.readOnly?"已开启只读查询，续取结果请重新执行":"已关闭只读查询","success"); for(const tab of getDb().tabs) {if(tab.kind==="sql" && tab.connId===connId && tab.slot) {claimCursor(connId,tab.slot,"readonly-toggle"); void dbApi.tx(connId,"status",tab.slot).then(r=>patchTab<SqlTab>(tab.id,{tx:r.tx}),()=>{});}} window.dispatchEvent(new CustomEvent("ncforge-db-readonly",{detail:{id:connId,...v}})); }
    catch(e) { toast(friendlyDbError(e),"error"); }
    finally { lock.current=false;setBusy(false); }
  };
  return <div className="dbx-context" data-prod={conn?.env === "prod" || undefined}>
    {conn ? <><strong>{conn.name}</strong><span>{ENV_LABEL[conn.env]}</span><span>{conn.user}@{dbNameOf(conn.url)}</span></> : <span>未选择数据库连接</span>}
    <span>{rt.status === "connected" ? "已连接" : rt.status === "connecting" ? "连接中…" : "未连接"}</span>
    <span title="只读查询模式使用 Oracle 只读事务并限制执行语句。账号权限仍由数据库配置；具有自治事务的函数须使用只读账号限制。" className="dbx-muted">{independent ? "当前 SQL 标签独立事务" : "表页与元数据共享事务"}</span>
    <button type="button" className="dbx-btn" disabled={busy || rt.status !== "connected" || readOnly === null} aria-pressed={readOnly ?? false} onClick={() => void toggle()}>{busy && <Icon name="spinner" size={12} />}{busy ? "切换中…" : readOnly === null && rt.status === "connected" ? "只读状态待验证" : readOnly ? "只读查询已开启" : "开启只读查询"}</button>
  </div>;
}
