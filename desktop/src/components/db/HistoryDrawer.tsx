import { useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import { clearHistory, filterHistory, getHistory, historyTime, subscribeHistory } from "../../lib/dbHistory";

/** 执行历史（按连接）：单击填回编辑器，双击填回并执行。 */
export function HistoryDrawer({ connId, onPick, onClose }: {
  connId: string;
  onPick: (sql: string, run: boolean) => void;
  onClose: () => void;
}) {
  const list = useSyncExternalStore(subscribeHistory, () => getHistory(connId));
  const [q, setQ] = useState("");
  const shown = useMemo(() => filterHistory(list, q), [list, q]);
  return (
    <div className="dbx-drawer">
      <div className="hd">
        <Icon name="history" size={14} />
        执行历史
        <span className="dbx-cnt">{list.length}</span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-ibtn" title="清空这个连接的历史" disabled={list.length === 0} onClick={() => clearHistory(connId)}>
          <Icon name="trash" size={13} />
        </button>
        <button type="button" className="dbx-ibtn" aria-label="关闭历史" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="flt">
        <input className="dbx-inp sm" value={q} placeholder="搜索 SQL" aria-label="搜索历史" onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="list">
        {shown.length === 0 && <p className="dbx-tree-note" style={{ padding: 12 }}>{list.length ? "没有匹配的记录" : "这个连接还没有执行记录"}</p>}
        {shown.map((h) => (
          <button
            key={`${h.at}-${h.sql.length}`}
            type="button"
            className="dbx-hitem"
            title="单击填回编辑器，双击填回并执行"
            onClick={() => onPick(h.sql, false)}
            onDoubleClick={() => onPick(h.sql, true)}
          >
            <span className="m">
              {historyTime(h.at)} · {h.ms} ms
              <span className={`r${h.ok ? "" : " fail"}`}>{h.summary}</span>
            </span>
            <code>{h.sql}</code>
          </button>
        ))}
      </div>
    </div>
  );
}
