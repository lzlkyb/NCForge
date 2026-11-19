import "./db-messages.css";
import { CodePreview } from "./CodePreview";
import { Icon } from "../ui/icon";
import { useRef, useState } from "react";
import { toast } from "../ui/toast";
import { friendlyDbError, oraCode, similarTo, tableRefs } from "../../lib/db";
import { oraHint } from "../../lib/oraErrorHint";
import { copyText } from "../../lib/utils";
import type { SqlQuickFix } from "../../lib/sqlQuickFix";

/**
 * 执行失败的说明。
 *
 * ORA-00942（表不存在）是最常见的错，而且往往只是手滑：给出库里相近的表名，
 * 点一下复制。其它错误原样给 ORA 文案，保留错误号给 DBA。
 */
import { openTable } from "../../lib/dbActions";
import { reconnectSession } from "../../lib/dbConfirm";
import { openSessionPanel, connOf, rtOf, type ResultEntry } from "../../lib/dbStore";

export function DbErrorBox({ error, sql, knownTables, index, connId, tabId, slot, errorCode, cancelled, contextSchema, onLocate, onFixes, onApply }: {
  onFixes?: () => Promise<SqlQuickFix[]>;
  onApply?: (fix: SqlQuickFix) => void;
  error: string;
  connId?:string|null; onLocate?:(line?:number)=>void;
  tabId?: string;
  slot?: string | null;
  errorCode?: ResultEntry["errorCode"];
  /** 用户主动停止：仍显示完整错误框，只在标题上标注「已停止」。 */
  cancelled?: boolean;
  /** 执行那一刻的 schema（结果上下文里的值）；缺省退回连接当前值。 */
  contextSchema?: string;
  sql: string;
  knownTables: string[];
  /** 脚本里的第几条。 */
  index?: number;
}) {
  const ora = oraCode(error);
  const lock = useRef(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [fixes, setFixes] = useState<SqlQuickFix[] | null>(null);
  const [checking, setChecking] = useState(false);
  // 942 最常见的真因不是表名手滑，而是「这条会话以谁的身份解析表名」：
  // 登录账号 / current_schema 与别的工具不一致。把解析上下文摆出来，省一轮盲猜。
  const rt = connId ? rtOf(connId) : undefined;
  const loginUser = rt?.info?.user ?? (connId ? connOf(connId)?.user : undefined);
  const execSchema = contextSchema ?? rt?.currentSchema ?? rt?.info?.schema;
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
  // 「错在哪一处」：ORA-00904 的标识符名就在错误文本里，能直接在语句里定位。
  const hint = oraHint(error, sql);
  return (
    // 执行失败是异步替换进来的状态：焦点还在编辑器里，不给 role 读屏用户什么都听不到。
    <div className="dbx-err dbx-feedback" role="alert">
      <div className="dbx-feedback-heading">
        <Icon name="alert" size={13} />
        {index ? `第 ${index} 条${cancelled ? "已停止" : "执行失败"}` : cancelled ? "执行已停止" : "执行失败"}
        {ora && <span className="dbx-mono">{ora}</span>}
      </div>
      <div className="dbx-feedback-message">{hint?.note ?? error}</div>
      {hint?.note && <details><summary>Oracle 错误详情</summary><div>{error}</div></details>}
      {errorCode === "timeout" && <div style={{ marginTop: 4 }}>不是语法错误，是等到上限还没跑完：可以在「查询设置」或表页筛选栏把等待上限调大后重试。</div>}
      {ora === "ORA-01031" && <div style={{ marginTop: 4 }}>当前账号没有这个操作的权限（读写权限由数据库账号决定）。</div>}
      {ora === "ORA-00942" && loginUser && (
        <div style={{ marginTop: 4 }}>
          登录账号 <code>{loginUser}</code> · 执行时 schema <code>{execSchema || "登录账号自身"}</code>。
          同一条语句在别的工具能执行，多半是登录账号或 current_schema 不同：核对连接与 schema 下拉，或用「检查可用修复」找表在哪个 schema。
        </div>
      )}
      {hint?.location && (
        <div style={{ marginTop: 4 }}>
          语句里 <code>{hint.location.ident.toUpperCase()}</code> 出现在第 {hint.location.line} 行第 {hint.location.column} 列
          {hint.location.occurrences > 1 && `（共 ${hint.location.occurrences} 处，先看第一处）`}
          {onLocate && <> · <button type="button" className="dbx-lk" onClick={() => onLocate(hint.location!.line)}>跳到这一行</button></>}
        </div>
      )}
      {suggestions.length > 0 && (
        <div style={{ marginTop: 4 }}>
          库里相近的表名（点击复制）：
          {suggestions.map((s) => (
            <button type="button" className="dbx-btn ghost" key={s} aria-label={`复制表名 ${s.toLowerCase()}`} onClick={() => void copyText(s.toLowerCase(), () => toast(`已复制 ${s.toLowerCase()}`, "success"), (e) => toast(`复制失败：${e}`, "error"))}>
              <code>{s.toLowerCase()}</code>
            </button>
          ))}
        </div>
      )}
      <div className="dbx-filter-actions">
        {onFixes && !cancelled && ["ORA-00942", "ORA-00904", "ORA-00918"].includes(ora ?? "") &&
          <button type="button" className="dbx-btn" disabled={checking} onClick={async () => {
            setChecking(true);
            try { setFixes(await onFixes()); }
            catch { toast("未能读取表结构，请稍后重试。", "warning"); }
            finally { setChecking(false); }
          }}>{checking ? "正在检查…" : "检查可用修复"}</button>}
        {fixes?.length === 0 && <span>没有找到可确认的替换。</span>}
        {fixes?.map(fix => {
          // 同一错列名可能出现多处（ORA-00904 每处都给修复）：同名候选要能区分、key 不能撞。
          const twins = fixes.filter(other => other.text === fix.text);
          const at = twins.length > 1 ? (() => { const before = sql.slice(0, fix.start); return `（第 ${before.split("\n").length} 行第 ${fix.start - before.lastIndexOf("\n")} 列）`; })() : "";
          return <button type="button" className="dbx-btn" key={`${fix.start}:${fix.text}`}
            onClick={() => { onApply?.(fix); setFixes(null); }}>{fix.schema !== undefined ? `切到 schema ${fix.schema}` : `替换为 ${fix.text}${at}`}</button>;
        })}
        {onLocate && <button type="button" className="dbx-btn" onClick={() => onLocate()}>定位 SQL 行</button>}
        {connId && ["ORA-00942","ORA-00904"].includes(ora ?? "") && tableRefs(sql).slice(0,1).map(t=><button key={t} type="button" className="dbx-btn" onClick={()=>void openTable(connId,t,"struct")}>查看 {t} 结构</button>)}
        {connId && ["ORA-00054","ORA-00060","ORA-01013"].includes(ora ?? "") && <button type="button" className="dbx-btn" onClick={()=>openSessionPanel(connId)}>查看会话与锁</button>}
        {connId && (errorCode === "session-lost" || errorCode === "fallback-session-lost") && <button type="button" className="dbx-btn" disabled={reconnecting} onClick={() => void reconnect()}>{reconnecting ? "正在重新连接…" : "重新连接"}</button>}
      </div>
      {sql && <CodePreview text={sql} label="失败的 SQL" connId={connId ?? undefined}/>}
    </div>
  );
}
