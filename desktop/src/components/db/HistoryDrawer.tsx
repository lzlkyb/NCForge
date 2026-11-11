import { useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import { Highlight } from "./Highlight";
import {
  clearHistory,
  filterHits,
  getHistoryMap,
  historyHits,
  historyTime,
  subscribeHistory,
} from "../../lib/dbHistory";
import { useDbConns } from "../../lib/dbStore";

/** 阅读或填回历史不会执行；执行必须选择独立操作。 */
export function HistoryDrawer({ connId, onPick, onClose }: {
  connId: string;
  onPick: (sql: string, run: boolean) => void;
  onClose: () => void;
}) {
  const map = useSyncExternalStore(subscribeHistory, getHistoryMap);
  // 订阅连接列表：跨连接搜索要显示连接名，连接改名 / 删除后这里得跟着变（查询结果 / 标签变化与它无关）
  const conns = useDbConns();
  const [q, setQ] = useState("");
  /** 搜索范围：默认只看当前连接（多数时候要找的就是它），要捞别的库时才开。 */
  const [all, setAll] = useState(false);
  const [fail, setFail] = useState(false);
  const [clearTarget, setClearTarget] = useState<string|null>(null);
  const targetName = conns.find(c => c.id === connId)?.name ?? connId;
  const here = map[connId] ?? [];
  const shown = useMemo(
    () => filterHits(historyHits(map, connId, all), q, fail),
    [map, connId, all, q, fail],
  );
  const total = all ? Object.values(map).reduce((n, l) => n + l.length, 0) : here.length;

  return (
    <div className="dbx-drawer">
      <div className="hd">
        <Icon name="history" size={14} />
        执行历史
        <span className="dbx-cnt">{total}</span>
        <span className="dbx-sp" />
        <button
          type="button"
          className="dbx-ibtn"
          title="清空这个连接的历史"
          disabled={here.length === 0}
          aria-label="清空当前连接历史" onClick={() => setClearTarget(connId)}
        >
          <Icon name="trash" size={13} />
        </button>
        <button type="button" className="dbx-ibtn" aria-label="关闭历史" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="flt">
        <input
          className="dbx-inp sm"
          value={q}
          placeholder="搜 SQL 或结果（如 ORA-00942）"
          aria-label="搜索历史"
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="dbx-flags">
          <label>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            全部连接
          </label>
          <label>
            <input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} />
            只看失败
          </label>
          {q.trim() !== "" && <span className="dbx-muted">{shown.length} 条命中</span>}
        </div>
      </div>
      <p className="dbx-tree-note" style={{padding:"4px 12px"}}>执行目标：<strong>{targetName}</strong>。其他连接的记录只填入，不直接执行。</p>
      {clearTarget === connId && <div className="dbx-history-clear" role="group" aria-label="确认清空历史">
        <p>清空「{targetName}」的 {here.length} 条执行历史？此操作不能撤销。</p>
        <button type="button" className="dbx-btn" onClick={()=>setClearTarget(null)}>取消清空</button>
        <button type="button" className="dbx-btn" onClick={()=>{clearHistory(connId);setClearTarget(null);}}>确认清空</button>
      </div>}
      <div className="list">
        {shown.length === 0 && (
          <p className="dbx-tree-note" style={{ padding: 12 }}>
            {total === 0
              ? "这个连接还没有执行记录"
              : fail
                ? "没有失败的记录"
                : all
                  ? "没有匹配的记录"
                  : "没有匹配的记录，试试勾上「全部连接」"}
          </p>
        )}
        {shown.map(({ connId: id, entry }) => (
          <div key={`${id}-${entry.at}-${entry.sql.length}`} className="dbx-hitem">
            <button type="button" className="dbx-history-content" title="填回编辑器，不执行" onClick={() => onPick(entry.sql, false)}>
            <span className="m">
              {all && <span className="dbx-hconn">来源：{conns.find((c) => c.id === id)?.name ?? "已删除的连接"}{id !== connId && ` → 编辑器：${targetName}`}</span>}
              {historyTime(entry.at)} · {entry.ms} ms
              <span className={`r${entry.ok ? "" : " fail"}`}>
                <Highlight text={entry.summary} query={q} />
              </span>
            </span>
            <code>
              <Highlight text={entry.sql} query={q} />
            </code>
            </button>
            <button type="button" className="dbx-btn ghost" title={id === connId ? `在当前连接 ${targetName} 中执行` : `来自其他连接，仅填入 ${targetName}，不会执行`} onClick={() => onPick(entry.sql, id === connId)}>{id === connId ? "填入并执行" : "填入（不执行）"}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
