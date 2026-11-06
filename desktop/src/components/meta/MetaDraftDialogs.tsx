import type { MetaDocument } from "../../hooks/useMetaDocuments";
import type { MetaDraft } from "../../lib/metaDraft";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";

export function MetaDraftDialogs({ draft, reviewOpen, closing, locked, onCancelReview, onSave, onCancelClose, onDiscardClose, onReviewClose }: {
  draft: MetaDraft; reviewOpen: boolean; closing: MetaDocument | null; locked: boolean;
  onCancelReview: () => void; onSave: () => void; onCancelClose: () => void;
  onDiscardClose: () => void; onReviewClose: () => void;
}) {
  const ready = draft.preview;
  const fresh = !!ready && draft.reviewedSha === ready.detail.sha256;
  const blockers = ready?.blockingIssues ?? [];
  return <>
    <Dialog open={reviewOpen} onClose={() => { if (!locked) onCancelReview(); }} ariaLabel="保存元数据草稿" zIndex={1250}>
      <DialogHeader><DialogTitle>保存当前文档草稿</DialogTitle></DialogHeader>
      <p className="meta-note">{draft.steps.length} 步修改将一次保存。保存前核对原文件，写入时保留备份。</p>
      <div className="meta-draft-steps">{draft.steps.map((step) => <span key={step.id}>{step.label}</span>)}</div>
      {draft.error && <div className="meta-error-box" role="alert"><pre>{draft.error}</pre></div>}
      {!!blockers.length && <div className="meta-error-box" role="alert"><strong>请先修正 {blockers.length} 个新增错误</strong>
        {blockers.slice(0, 8).map((issue) => <p key={issue.id}>{issue.title}：{issue.action}</p>)}</div>}
      <pre className="meta-diff meta-draft-diff" aria-label="草稿差异">{ready?.diff || "文件内容没有变化。"}</pre>
      {!fresh && <p className="meta-note">草稿已变化，请关闭后重新预览。</p>}
      <div className="meta-dialog-actions"><Button variant="ghost" disabled={locked} onClick={onCancelReview}>继续编辑</Button>
        <Button disabled={locked || !fresh || !!blockers.length || !draft.steps.length} onClick={onSave}>{draft.busy ? "正在保存…" : "保存全部修改"}</Button></div>
    </Dialog>
    <Dialog open={!!closing} onClose={onCancelClose} ariaLabel="关闭未保存的元数据文档" zIndex={1250}>
      <DialogHeader><DialogTitle>这个文档还有待保存的修改</DialogTitle></DialogHeader>
      <p className="meta-note">{closing?.entry.displayName || closing?.entry.name} 的草稿尚未写入文件。</p>
      <div className="meta-dialog-actions"><Button variant="ghost" onClick={onCancelClose}>继续编辑</Button>
        <Button variant="outline" onClick={onDiscardClose}>放弃并关闭</Button><Button onClick={onReviewClose}>预览后保存</Button></div>
    </Dialog>
  </>;
}
