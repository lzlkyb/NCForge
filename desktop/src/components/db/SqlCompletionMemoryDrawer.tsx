import { useState, useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { useConnOf, useConnRt } from "../../lib/dbStore";
import { connectionKey } from "../../lib/dbResultContext";
import { clearSqlJoinHistory, snapshotSqlJoinHistory, sqlJoinHistoryGeneration } from "../../lib/sqlJoinHistory";
import { clearSqlUsage, forgetSqlUsage, getSqlUsageEnabled, restoreSqlUsage, setSqlUsageEnabled, setSqlUsagePinned, sqlUsageScope, subscribeSqlUsage, usageSnapshot } from "../../lib/sqlUsage";

export function SqlCompletionMemoryDrawer({ connId, onClose }: { connId: string; onClose: () => void }) {
  const conn = useConnOf(connId), rt = useConnRt(connId);
  const scope = sqlUsageScope(connectionKey(conn), rt.currentSchema ?? rt.info?.schema);
  const memory = useSyncExternalStore(subscribeSqlUsage, () => usageSnapshot(scope));
  const enabled = useSyncExternalStore(subscribeSqlUsage, getSqlUsageEnabled);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const entries = Object.entries(memory).map(([key, entry]) => {
    let parts: string[] = [];
    try {
      const parsed: unknown = JSON.parse(key);
      if (Array.isArray(parsed) && parsed.every(part => typeof part === "string")) parts = parsed;
    } catch { /* Malformed old identities remain removable. */ }
    const [table, field, clause] = parts;
    const title = field ? `${table}.${field}` : table || key;
    const zh = rt.ncNames?.[table?.toLowerCase()] ?? "";
    return { key, entry, title, zh, clause };
  }).filter(item => `${item.title} ${item.zh}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.entry.pinned) - Number(a.entry.pinned) || b.entry.lastUsed - a.entry.lastUsed || a.title.localeCompare(b.title));
  const save = (ok: boolean) => setFailed(!ok);
  const clear = () => {
    const snapshot = usageSnapshot(scope);
    const restoreJoins = snapshotSqlJoinHistory(scope);
    const usageOk = clearSqlUsage(scope);
    const joinsOk = clearSqlJoinHistory(scope);
    const generation = sqlJoinHistoryGeneration(scope);
    save(usageOk && joinsOk);
    setConfirm(null);
    toast.info("已清除补全记忆和 JOIN 历史", { key: `sql-memory-${scope}`, action: { label: "撤销", onClick: () => {
      if (sqlJoinHistoryGeneration(scope) !== generation) return;
      const restoredUsage = restoreSqlUsage(scope, snapshot);
      const restoredJoins = restoreJoins();
      if (!restoredUsage || !restoredJoins) toast.warning("已恢复到当前会话，但无法保存到本机。");
      else toast.success("已恢复补全记忆和 JOIN 历史");
    } } });
  };
  return <div className="dbx-drawer dbx-assist-memory">
    <div className="hd"><Icon name="history" size={14} />补全记忆<span className="dbx-cnt">{Object.keys(memory).length}</span><span className="dbx-sp" />
      <button type="button" className="dbx-ibtn" aria-label="清除当前 schema 补全记忆" onClick={() => setConfirm(scope)}><Icon name="trash" size={13} /></button>
      <button type="button" className="dbx-ibtn" aria-label="关闭补全记忆" onClick={onClose}><Icon name="close" size={13} /></button>
    </div>
    <div className="flt"><input className="dbx-inp sm" aria-label="搜索补全记忆" placeholder="表名、字段或中文说明" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="dbx-flags"><label><input type="checkbox" checked={enabled} onChange={e => save(setSqlUsageEnabled(e.target.checked))} />根据使用习惯排序</label></div>
    </div>
    <p className="dbx-tree-note">{conn?.name} · {rt.currentSchema || "当前 schema"}。固定项优先，忘记后仍可正常搜索。</p>
    {failed && <p className="dbx-tree-note" role="status">本次会话已生效，但无法保存到本机。</p>}
    {confirm === scope && <div className="dbx-history-clear" role="group" aria-label="确认清除补全记忆"><p>清除当前连接和 schema 的使用记录、固定项及 JOIN 历史？</p>
      <button type="button" className="dbx-btn" onClick={() => setConfirm(null)}>取消</button><button type="button" className="dbx-btn" onClick={clear}>确认清除</button></div>}
    <div className="list">{entries.length === 0 && <p className="dbx-tree-note">{query ? "没有匹配的记忆" : "接受补全或输入完整表名后，常用对象会出现在这里。"}</p>}
      {entries.map(({ key, entry, title, zh, clause }) => <div key={key} className="dbx-hitem"><code>{title}</code><span className="m">{zh}{clause ? ` · ${clause.toUpperCase()}` : ""} · {entry.count} 次{entry.pinned && " · 已固定"} · {entry.lastUsed ? <time dateTime={new Date(entry.lastUsed).toISOString()}>{new Date(entry.lastUsed).toLocaleString("zh-CN")}</time> : "尚未使用"}</span>
        <div className="dbx-assist-memory-actions"><button type="button" className="dbx-btn ghost" aria-label={`${entry.pinned ? "取消固定" : "固定"} ${title}`} onClick={() => save(setSqlUsagePinned(scope, key, !entry.pinned))}>{entry.pinned ? "取消固定" : "固定优先"}</button>
          <button type="button" className="dbx-btn ghost" aria-label={`忘记 ${title}`} onClick={() => save(forgetSqlUsage(scope, key))}>忘记</button></div></div>)}
    </div>
  </div>;
}
