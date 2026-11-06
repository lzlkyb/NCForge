import { useState } from "react";
import type { MetaDraft } from "../../lib/metaDraft";
import { Icon } from "../ui/icon";
import { ConfirmDialog } from "../ui/ConfirmDialog";

export function MetaDraftBar({ draft, locked, onUndo, onRedo, onReview, onDiscard }: {
  draft: MetaDraft; locked: boolean; onUndo: () => void; onRedo: () => void;
  onReview: () => void; onDiscard: () => void;
}) {
  const [discardOpen, setDiscardOpen] = useState(false);
  if (!draft.steps.length && !draft.redo.length && !draft.error) return null;
  return <div className="meta-draft-bar" aria-label="当前文档草稿">
    <div className="meta-draft-summary" role="status"><Icon name="edit" size={13} />
      <span>{draft.busy ? "正在校验草稿…" : `${draft.steps.length} 步待保存`}</span>
      {draft.error && <span className="meta-draft-error" title={draft.error}>{draft.error}</span>}
    </div>
    <button type="button" className="meta-link" disabled={locked || !draft.steps.length} onClick={onUndo}>撤销</button>
    <button type="button" className="meta-link" disabled={locked || !draft.redo.length} onClick={onRedo}>重做</button>
    <button type="button" className="meta-link" disabled={locked} onClick={() => setDiscardOpen(true)}>放弃草稿</button>
    <button type="button" className="meta-link meta-draft-save" disabled={locked || !draft.steps.length} onClick={onReview}><Icon name="file" size={13} />预览保存</button>
    {discardOpen && <ConfirmDialog title="放弃当前文档草稿？" description="已加入草稿的修改将清除，磁盘文件保持原样。"
      confirmLabel="放弃草稿" variant="destructive" onCancel={() => setDiscardOpen(false)} onConfirm={() => { setDiscardOpen(false); onDiscard(); }} />}
  </div>;
}
