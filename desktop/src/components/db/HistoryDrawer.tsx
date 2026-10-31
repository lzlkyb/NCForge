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
import { connOf, useDb } from "../../lib/dbStore";

/** 执行历史：单击填回编辑器，双击填回并执行。 */
export function HistoryDrawer({ connId, onPick, onClose }: {
  connId: string;
  onPick: (sql: string, run: boolean) => void;
  onClose: () => void;
}) {
  const map = useSyncExternalStore(subscribeHistory, getHistoryMap);
  // 订阅连接列表：跨连接搜索要显示连接名，连接改名 / 删除后这里得跟着变
  useDb();
  const [q, setQ] = useState("");
  /** 搜索范围：默认只看当前连接（多数时候要找的就是它），要捞别的库时才开。 */
  const [all, setAll] = useState(false);
  const [fail, setFail] = useState(false);
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
          onClick={() => clearHistory(connId)}
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
          <button
            key={`${id}-${entry.at}-${entry.sql.length}`}
            type="button"
            className="dbx-hitem"
            title="单击填回编辑器，双击填回并执行"
            onClick={() => onPick(entry.sql, false)}
            onDoubleClick={() => onPick(entry.sql, true)}
          >
            <span className="m">
              {all && <span className="dbx-hconn">{connOf(id)?.name ?? "已删除的连接"}</span>}
              {historyTime(entry.at)} · {entry.ms} ms
              <span className={`r${entry.ok ? "" : " fail"}`}>
                <Highlight text={entry.summary} query={q} />
              </span>
            </span>
            <code>
              <Highlight text={entry.sql} query={q} />
            </code>
          </button>
        ))}
      </div>
    </div>
  );
}
