import { Icon } from "../ui/icon";
import { useRef, useState } from "react";
import { toast } from "../ui/toast";
import { friendlyDbError, oraCode, similarTo, tableRefs } from "../../lib/db";
import { copyText } from "../../lib/utils";

/**
 * 执行失败的说明。
 *
 * ORA-00942（表不存在）是最常见的错，而且往往只是手滑：给出库里相近的表名，
 * 点一下复制。其它错误原样给 ORA 文案，保留错误号给 DBA。
 */
import { openTable } from "../../lib/dbActions";
import { reconnectSession } from "../../lib/dbConfirm";
import { openSessionPanel, type ResultEntry } from "../../lib/dbStore";

export function DbErrorBox({ error, sql, knownTables, index, connId, tabId, slot, errorCode, cancelled, onLocate }: {
  error: string;
  connId?:string|null; onLocate?:()=>void;
  tabId?: string;
  slot?: string | null;
  errorCode?: ResultEntry["errorCode"];
  /** 用户主动停止：仍显示完整错误框，只在标题上标注「已停止」。 */
  cancelled?: boolean;
  sql: string;
  knownTables: string[];
  /** 脚本里的第几条。 */
  index?: number;
}) {
  const ora = oraCode(error);
  const lock = useRef(false);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnect = async () => {
    if (!connId || lock.current) return;
    lock.current = true;
    setReconnecting(true);
    try {
      await reconnectSession(connId, slot ?? null, tabId, errorCode === "fallback-session-lost");
    } catch (e) {
      toast(friendlyDbError(e), "error");
    } finally {
      lock.current = false;
      setReconnecting(false);
    }
  };
  const suggestions =
    ora === "ORA-00942" ? [...new Set(tableRefs(sql).flatMap((t) => similarTo(t, knownTables, 2)))].slice(0, 3) : [];
  return (
    // 执行失败是异步替换进来的状态：焦点还在编辑器里，不给 role 读屏用户什么都听不到。
    <div className="dbx-err" role="alert">
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
        <Icon name="alert" size={13} />
        {index ? `第 ${index} 条${cancelled ? "已停止" : "执行失败"}` : cancelled ? "执行已停止" : "执行失败"}
        {ora && <span className="dbx-mono">{ora}</span>}
      </div>
      <div style={{ marginTop: 4, wordBreak: "break-all" }}>{error}</div>
      {ora === "ORA-01031" && <div style={{ marginTop: 4 }}>当前账号没有这个操作的权限（读写权限由数据库账号决定）。</div>}
      {suggestions.length > 0 && (
        <div style={{ marginTop: 4 }}>
          库里相近的表名（点击复制）：
          {suggestions.map((s) => (
            <code key={s} onClick={() => void copyText(s.toLowerCase(), () => toast(`已复制 ${s.toLowerCase()}`, "success"), (e) => toast(`复制失败：${e}`, "error"))}>
              {s.toLowerCase()}
            </code>
          ))}
        </div>
      )}
      <div className="dbx-filter-actions">
        {onLocate && <button type="button" className="dbx-btn" onClick={onLocate}>定位 SQL 行</button>}
        {connId && ["ORA-00942","ORA-00904"].includes(ora ?? "") && tableRefs(sql).slice(0,1).map(t=><button key={t} type="button" className="dbx-btn" onClick={()=>void openTable(connId,t,"struct")}>查看 {t} 结构</button>)}
        {connId && ["ORA-00054","ORA-00060","ORA-01013"].includes(ora ?? "") && <button type="button" className="dbx-btn" onClick={()=>openSessionPanel(connId)}>查看会话与锁</button>}
        {connId && (errorCode === "session-lost" || errorCode === "fallback-session-lost") && <button type="button" className="dbx-btn" disabled={reconnecting} onClick={() => void reconnect()}>{reconnecting ? "正在重新连接…" : "重新连接"}</button>}
      </div>
      {sql && <pre>{sql}</pre>}
    </div>
  );
}
