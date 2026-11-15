import { useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import { Highlight } from "./Highlight";
import {
  clearHistory,
  changeHistoryEntry,
  getHistoryMap,
  historyTime,
  subscribeHistory,
  type HistoryEntry,
} from "../../lib/dbHistory";
import { useConnRt, useDbConns } from "../../lib/dbStore";
import { snippetsSnapshot, subscribeSnippets } from "../../lib/dbSnippets";
import { recallSql } from "../../lib/sqlRecall";
import { canParameterizeQuery } from "../../lib/sqlQueryParameters";
import { SaveQueryTemplate } from "./SqlParameterDialog";

/** 阅读或填回历史不会执行；执行必须选择独立操作。 */
export function HistoryDrawer({ connId, onPick, onClose }: {
  connId: string;
  onPick: (sql: string, run: boolean) => void;
  onClose: () => void;
}) {
  const map = useSyncExternalStore(subscribeHistory, getHistoryMap);
  // 订阅连接列表：跨连接搜索要显示连接名，连接改名 / 删除后这里得跟着变（查询结果 / 标签变化与它无关）
  const conns = useDbConns();
  const runtime = useConnRt(connId);
  const schema = runtime.currentSchema ?? runtime.info?.schema;
  const snippets = useSyncExternalStore(subscribeSnippets, () => snippetsSnapshot(connId));
  const [q, setQ] = useState("");
  const [template, setTemplate] = useState<HistoryEntry | null>(null);
  /** 搜索范围：默认只看当前连接（多数时候要找的就是它），要捞别的库时才开。 */
  const [all, setAll] = useState(false);
  const [fail, setFail] = useState(false);
  const [clearTarget, setClearTarget] = useState<string|null>(null);
  const targetName = conns.find(c => c.id === connId)?.name ?? connId;
  const here = map[connId] ?? [];
  const shown = useMemo(
    () => recallSql(map, snippets, { connId, schema, all, failed: fail, query: q, names: runtime.ncNames ?? {} }),
    [map, snippets, connId, schema, all, q, fail, runtime.ncNames],
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
          placeholder="搜表名、业务名、历史和片段"
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
      <p className="dbx-tree-note" style={{padding:"4px 12px"}}>当前目标 <strong>{[targetName, schema].filter(Boolean).join(" · ")}</strong></p>
      {clearTarget === connId && <div className="dbx-history-clear" role="group" aria-label="确认清空历史">
        <p>清空「{targetName}」的 {here.length} 条执行历史？此操作不能撤销。</p>
        <button type="button" className="dbx-btn" onClick={()=>setClearTarget(null)}>取消清空</button>
        <button type="button" className="dbx-btn" onClick={()=>{clearHistory(connId);setClearTarget(null);}}>确认清空</button>
      </div>}
      <div className="list">
        {shown.length === 0 && (
          <p className="dbx-tree-note" style={{ padding: 12 }}>
            {fail
                ? "没有失败的记录"
              : !q.trim() && total === 0
                ? "这个连接还没有执行记录或片段"
                : all
                  ? "没有匹配的记录"
                  : "没有匹配的记录，试试勾上「全部连接」"}
          </p>
        )}
        {shown.map(hit => {
          if (hit.kind !== "history") return (
            <div key={hit.entry.id} className="dbx-hitem">
              <button type="button" className="dbx-history-content" title="填回编辑器，不执行" onClick={() => onPick(hit.sql, false)}>
                <span className="m">{hit.kind === "template" ? "查询模板" : "SQL 片段"} · <Highlight text={hit.entry.name} query={q} />{hit.entry.schema && <span>{hit.entry.schema}</span>}</span>
                <code><Highlight text={hit.sql} query={q} /></code>
              </button>
            </div>
          );
          const { connId: id, entry } = hit;
          const canRun = id === connId && (entry.schema === undefined || entry.schema === schema);
          return (
          <div key={JSON.stringify([id, entry.schema, entry.at, entry.sql])} className="dbx-hitem">
            <button type="button" className="dbx-history-content" title="填回编辑器，不执行" onClick={() => onPick(entry.sql, false)}>
            <span className="m">
              {all && <span className="dbx-hconn">来源：{conns.find((c) => c.id === id)?.name ?? "已删除的连接"}{id !== connId && ` → 编辑器：${targetName}`}</span>}
              {historyTime(entry.at)} · {entry.ms} ms
              {entry.schema && <span>{entry.schema}</span>}
              {entry.pinned && <span>已固定</span>}
              <span className={`r${entry.ok ? "" : " fail"}`}>
                <Highlight text={entry.summary} query={q} />
              </span>
            </span>
            <code>
              <Highlight text={entry.sql} query={q} />
            </code>
            </button>
            <div className="dbx-filter-actions">
            {id === connId && entry.ok && canParameterizeQuery(entry.sql) && <button type="button" className="dbx-btn ghost" onClick={() => setTemplate(entry)}>保存为模板</button>}
            <button type="button" className="dbx-btn ghost" onClick={() => changeHistoryEntry(id, entry, "pin")}>{entry.pinned ? "取消固定" : "固定"}</button>
            <button type="button" className="dbx-btn ghost" onClick={() => changeHistoryEntry(id, entry, "forget")}>移除记录</button>
            <button type="button" className="dbx-btn ghost" title={canRun ? `在当前连接 ${targetName} 中执行` : "来源与当前执行目标不同"} onClick={() => onPick(entry.sql, canRun)}>{canRun ? "填入并执行" : "填入（不执行）"}</button>
            </div>
          </div>
          );
        })}
      </div>
      {template && <SaveQueryTemplate sql={template.sql} connId={connId} schema={template.schema} onClose={() => setTemplate(null)} />}
    </div>
  );
}
