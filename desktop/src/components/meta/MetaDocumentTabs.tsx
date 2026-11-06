import type { MetaDocument } from "../../hooks/useMetaDocuments";
import { draftChanged } from "../../lib/metaDraft";
import { Icon } from "../ui/icon";

export function MetaDocumentTabs({ documents, active, locked, onSelect, onClose }: {
  documents: MetaDocument[]; active: string; locked: boolean;
  onSelect: (doc: MetaDocument) => void; onClose: (key: string) => void;
}) {
  return <nav className="meta-document-tabs" aria-label="打开的元数据文档">
    {documents.map((doc) => <div key={doc.key} className={`meta-document-tab ${doc.key === active ? "is-active" : ""}`}>
      <button type="button" disabled={locked} onClick={() => onSelect(doc)} aria-current={doc.key === active ? "page" : undefined} title={doc.entry.path}>
        <Icon name="metaFile" size={13} /><span>{doc.entry.displayName || doc.entry.name}</span>
        {(draftChanged(doc.draft) || (locked && doc.key === active)) && <span className="meta-draft-dot" aria-label={draftChanged(doc.draft) ? "待保存" : "编辑中"} />}
      </button>
      <button type="button" disabled={locked} className="meta-document-close" aria-label={`关闭 ${doc.entry.name}`} onClick={() => onClose(doc.key)}><Icon name="close" size={12} /></button>
    </div>)}
  </nav>;
}
