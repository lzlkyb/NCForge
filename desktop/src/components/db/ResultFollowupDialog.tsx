import { useEffect, useState } from "react";
import { dbApi, type Cell, type ColumnMeta } from "../../lib/dbApi";
import { friendlyDbError } from "../../lib/db";
import { relationRows } from "../../lib/dbRelations";
import { resultRelationQuery, type ResultFollowup } from "../../lib/dbResultFollowup";
import { claimCursor } from "../../lib/dbStore";
import type { QuerySource } from "../../lib/sqlSource";
import { Modal } from "../ui/Modal";
import { CodePreview } from "./CodePreview";

export function ResultFollowupDialog({ query, target, onClose, onRun }: {
  query: ResultFollowup; target: string; onClose: () => void; onRun: () => void;
}) {
  return <Modal open onClose={onClose} ariaLabel={query.title} className="modal-surface dbx-parameter-dialog">
    <h2>{query.title}</h2>
    <p className="dbx-parameter-target"><span>查询目标</span><strong>{target}</strong></p>
    <CodePreview text={query.sql} expandable={false} />
    {query.params.length > 0 && <details><summary>绑定参数 · {query.params.length} 个</summary>
      <ol>{query.params.map((value, i) => <li key={i}><code>{value && typeof value === "object" ? value.number : String(value)}</code></li>)}</ol>
    </details>}
    <p className="dbx-muted">{query.executable ? "查询会生成新结果，可以返回原选区。" : "来源包含复杂查询或计算列。可复制条件，在编辑器中核对字段和参数。"}</p>
    <div className="dbx-parameter-footer">
      <button type="button" className="dbx-btn" onClick={onClose}>{query.executable ? "取消" : "关闭"}</button>
      {query.executable && <button type="button" className="dbx-btn pri" onClick={onRun}>执行查询</button>}
    </div>
  </Modal>;
}

export function ResultRelationPicker({ connId, schema, source, columns, row, onClose, onPick }: {
  connId: string; schema?: string; source: QuerySource; columns: ColumnMeta[]; row: Cell[];
  onClose: () => void; onPick: (query: ResultFollowup) => void;
}) {
  const [result, setResult] = useState<{ queries: ResultFollowup[]; error?: string; partial?: boolean } | null>(null);
  const table = source.table?.split(".").pop();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!table) return;
    let active = true;
    void dbApi.relations(connId, table).then(response => {
      if (response.sharedSession) claimCursor(connId, null, `relations:${table}`);
      if (!active) return;
      const relations = [...relationRows(response.foreign, "外键"), ...relationRows(response.references, "NC类引用")];
      const queries = relations.flatMap(relation => {
        try { return [resultRelationQuery(relation, source, schema, columns, row)]; }
        catch { return []; }
      });
      setResult({ queries, partial: response.partial || !!response.notes?.length });
    }, error => { if (active) setResult({ queries: [], error: friendlyDbError(error) }); });
    return () => { active = false; };
  }, [table, connId, revision, schema, source, columns, row]);
  return <Modal open onClose={onClose} ariaLabel="追查关联记录" className="modal-surface dbx-relations-dialog">
    <h2>追查关联记录</h2>
    <p className="dbx-muted">{[schema, table].filter(Boolean).join(".")} · 使用当前行的关联键</p>
    {!result ? <p role="status">读取关联…</p> : result.error ? <div role="alert">
      {result.error} <button type="button" className="dbx-btn" onClick={() => { setResult(null); setRevision(n => n + 1); }}>重试</button>
    </div> : <>
      {result.queries.map((query, index) => <div className="dbx-relation" key={`${query.sql}:${index}`}>
        <strong>{query.title}</strong><span><code>{query.sql.slice(query.sql.lastIndexOf("\n") + 1)}</code></span>
        <button type="button" className="dbx-btn" onClick={() => onPick(query)}>查看 SQL</button>
      </div>)}
      {!result.queries.length && <p>当前行没有可确认的关联键。请在原查询中带出关联字段再试。</p>}
      {result.partial && <p className="dbx-muted">部分关系或元数据未能读取。</p>}
    </>}
    <div className="dbx-parameter-footer"><button type="button" className="dbx-btn" onClick={onClose}>关闭</button></div>
  </Modal>;
}
