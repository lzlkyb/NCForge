import { useState } from "react";
import { Icon } from "../ui/icon";
import { dbConnectionHint } from "../../lib/dbConnectionHint";
import { copyText } from "../../lib/utils";
import { ensureConnected } from "../../lib/dbConfirm";
import { loadConns, openConnDialog, useDbConns, useDbRt, useDbSelector } from "../../lib/dbStore";
import "./db-messages.css";

/** 直接使用运行态作为消息来源，连接恢复或删除后不遗留过期告警。 */
export function DbMessages() {
  const conns = useDbConns();
  const runtime = useDbRt();
  const loadError = useDbSelector((s) => s.loadError);
  const [collapsed, setCollapsed] = useState(false);
  const [retrying, setRetrying] = useState<Record<string, string>>({});
  const failures = conns.filter((c) => runtime[c.id]?.status === "error" || retrying[c.id]);
  // 连接命令会先清除旧错误并进入 connecting；保留本次重试的提示，避免界面闪退。
  const retryConnection = async (id: string, error: string) => {
    setRetrying((current) => ({ ...current, [id]: error }));
    try { await ensureConnected(id); }
    finally {
      setRetrying((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };
  const count = failures.length + (loadError ? 1 : 0);
  if (!count) return null;

  return <section className="dbx-messages" aria-label="数据库消息">
    <div className="dbx-messages-heading">
      <strong>连接提醒</strong><span className="dbx-messages-count">{count} 项待处理</span>
      <button type="button" className="dbx-ibtn" aria-label={collapsed ? "展开数据库消息" : "收起数据库消息"} aria-expanded={!collapsed} aria-controls="dbx-message-list" onClick={() => setCollapsed(!collapsed)}>
        <Icon name="chevronDown" size={14} className={collapsed ? "" : "dbx-message-chevron-open"} />
      </button>
    </div>
    <div id="dbx-message-list" className="dbx-message-list" hidden={collapsed}>
      {loadError && <Message source="连接配置" title="连接列表暂时无法读取" help="请重试读取；如果仍无法读取，可通过诊断详情排查配置文件访问问题。" error={loadError} retry={() => loadConns()} />}
      {failures.map((conn) => {
        const error = retrying[conn.id] || runtime[conn.id]?.error || "无法建立连接，请检查连接配置后重试。";
        return <Message key={conn.id} source={conn.name} {...dbConnectionHint(error)} error={error} retry={() => retryConnection(conn.id, error)} edit={() => openConnDialog(conn.id)} />;
      })}
    </div>
  </section>;
}

function Message({ source, title, help, error, settingsFirst, retry, edit }: {
  source: string; title: string; help: string; error: string; settingsFirst?: boolean;
  retry: () => Promise<unknown>; edit?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const again = async () => {
    if (busy) return;
    setBusy(true);
    setFeedback("");
    try { await retry(); }
    catch { setFeedback("操作未完成，请查看诊断详情后再试。"); }
    finally { setBusy(false); }
  };
  const retryButton = <button type="button" className={`dbx-btn ${settingsFirst && edit ? "ghost" : "pri"}`} disabled={busy} onClick={() => void again()}>
    <Icon name="refresh" size={13} />{busy ? "正在尝试…" : edit ? "重新连接" : "重试读取"}
  </button>;
  const editButton = edit && <button type="button" className={`dbx-btn ${settingsFirst ? "pri" : "ghost"}`} disabled={busy} onClick={edit}>连接设置</button>;
  return <article className="dbx-message">
    <div className="dbx-message-symbol" aria-hidden="true"><Icon name={settingsFirst ? "key" : "plug"} size={19} /></div>
    <div className="dbx-message-content">
      <div className="dbx-message-row">
        <div className="dbx-message-text" role="status">
          <div className="dbx-message-title"><h3>{title}</h3><span className="dbx-message-source" title={source}>{source}</span></div>
          <p>{help}</p>
        </div>
        <div className="dbx-message-actions">{settingsFirst ? <>{editButton}{retryButton}</> : <>{retryButton}{editButton}</>}</div>
      </div>
      <details className="dbx-message-details">
        <summary>诊断详情</summary>
        <div className="dbx-message-diagnostic">
          <div className="dbx-message-diagnostic-heading"><span>连接返回的信息</span><button type="button" className="dbx-btn ghost" onClick={() => void copyText(error, () => setFeedback("诊断信息已复制"), () => setFeedback("复制未完成，可选中下方文字手动复制。"))}><Icon name="copy" size={12} />复制详情</button></div>
          <p>{error}</p>
        </div>
      </details>
      {feedback && <p className="dbx-message-feedback" role="status">{feedback}</p>}
    </div>
  </article>;
}
