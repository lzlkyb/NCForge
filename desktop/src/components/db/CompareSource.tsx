import { CodePreview } from "./CodePreview";
import type { ResultSnapshot } from "../../lib/dbResultTools";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";

/** Identity comes from the captured execution, never from the connection's current settings. */
export function CompareSource({ snapshot, side, expanded=false }: { snapshot:ResultSnapshot; side:"A"|"B"; expanded?:boolean }) {
  const sql=snapshot.sql.replace(/\s+/g," ").trim();
  return <details className="dbx-compare-source" open={expanded || undefined}>
    <summary>
      <span className="dbx-compare-source-title"><b>{side} · {side==="A" ? "对照值" : "当前值"}</b><strong title={snapshot.source}>{snapshot.source}</strong></span>
      <span className="dbx-compare-source-meta"><span>schema：{snapshot.schema || "未记录"}</span><time dateTime={new Date(snapshot.at).toISOString()}>{new Date(snapshot.at).toLocaleString()}</time><span>{snapshot.rows.length.toLocaleString()} 行</span><span data-partial={!snapshot.complete || undefined}>{snapshot.complete ? "完整查询结果" : "部分结果"}</span></span>
      <span className="dbx-compare-source-sql" title="展开查看完整 SQL">{sql ? `${sql.slice(0,140)}${sql.length>140 ? "…" : ""}` : "SQL 未记录"}</span>
    </summary>
    <CodePreview label={`${side} 来源 SQL`} text={snapshot.sql || "SQL 未记录"}/>
  </details>;
}

export function CompareSourceDialog({ before, after, open, onClose }: { before?:ResultSnapshot|null; after?:ResultSnapshot; open:boolean; onClose:()=>void }) {
  const title=after ? "比较来源" : "对照来源";
  return <Modal open={open} onClose={onClose} ariaLabel={title} className="modal-surface dbx-compare-source-dialog">
    <div className="dbx-compare-source-heading"><h2>{title}</h2><button type="button" className="dbx-ibtn" aria-label="关闭来源" onClick={onClose}><Icon name="close" size={14} /></button></div>
    {before && <CompareSource snapshot={before} side="A" expanded />}
    {after && <CompareSource snapshot={after} side="B" expanded />}
    <p>固定和比对均使用全部已加载数据，包含隐藏列；对照仅保留在本次工作台。</p>
  </Modal>;
}
