import type { BmfArtifactStatus, BmfGenPlan } from "../../lib/bmf";
import { type GenerationSnapshot, type GenerationResult } from "../../lib/bmfGeneration";
import { generationCounts, generationPath, GENERATION_STATUSES } from "../../lib/metaGeneration";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

export interface GenerationReview { snapshot: GenerationSnapshot; selected: string[]; overrides: string[] }
interface Props {
  plan: BmfGenPlan | null; statuses: Record<string, BmfArtifactStatus>; review: GenerationReview | null;
  result: GenerationResult | null; resultOpen: boolean; root: string; applying: boolean;
  onCloseReview: () => void; onConfirm: () => void; onCloseResult: () => void;
  onOpen: (path: string) => void; onReveal: (path: string) => void;
}
const WRITE_LABELS: Record<string, string> = { written: "已新建", replaced: "已更新", skipped: "已跳过", failed: "失败" };

export function GenWriteDialogs({ plan, statuses, review, result, resultOpen, root, applying,
  onCloseReview, onConfirm, onCloseResult, onOpen, onReveal }: Props) {
  const counts = generationCounts(plan, statuses, review?.selected ?? [], review?.overrides ?? []);
  return <>
    <Modal keepMountedWhenInactive open={!!review} onClose={() => { if (!applying) onCloseReview(); }} closeOnOverlay={!applying} ariaLabel="确认写入生成产物" className="gen-modal modal-surface">
      <header className="gen-modal-head"><h3>确认写入生成产物</h3><Button size="sm" variant="ghost" disabled={applying} onClick={onCloseReview} aria-label="关闭写入确认"><Icon name="close" size={16} /></Button></header>
      <p className="gen-modal-path">{review?.snapshot.root}</p><p>已选 {counts.selected} 个 · 新建 {counts.create} · 更新 {counts.update} · 保留 {counts.keep} · 已一致 {counts.same}</p>
      <div className="gen-review-list">{plan?.artifacts.filter((a) => review?.selected.includes(a.id)).map((a) => <div key={a.id}><span>{a.pathHint}</span><small className={review?.overrides.includes(a.id) ? "gen-warning" : ""}>{review?.overrides.includes(a.id) ? "覆盖并备份" : GENERATION_STATUSES[statuses[a.id]?.status ?? ""] ?? "待检查"}</small></div>)}</div>
      <p className="gen-note">写入前再次核对源、配置与目标版本。已有文件更新前保留备份。</p>
      <footer className="gen-modal-actions"><Button size="sm" variant="outline" disabled={applying} onClick={onCloseReview}>返回检查</Button><Button size="sm" disabled={applying} onClick={onConfirm}>{applying ? "写入中…" : "确认写入"}</Button></footer>
    </Modal>
    <Modal keepMountedWhenInactive open={!!result && resultOpen} onClose={onCloseResult} ariaLabel="生成写入结果" className="gen-modal modal-surface">
      <header className="gen-modal-head"><h3>生成写入结果</h3><Button size="sm" variant="ghost" onClick={onCloseResult} aria-label="关闭写入结果"><Icon name="close" size={16} /></Button></header>
      <p>已写入 <strong>{result?.written ?? 0}</strong> · 跳过 {result?.skipped ?? 0} · 失败 {result?.failed ?? 0}</p>
      <div className="gen-review-list">{result?.items.map((item) => <div className={`gen-result-row is-${item.status}`} key={item.relPath}><span><strong>{WRITE_LABELS[item.status]}</strong> {item.relPath}<small>{item.detail}</small></span>
        {(item.status === "written" || item.status === "replaced") && <Button size="sm" variant="ghost" onClick={() => onOpen(result.paths[item.relPath] || generationPath(root, item.relPath))}>打开</Button>}
        {result.backups[item.relPath] && <Button size="sm" variant="ghost" onClick={() => onReveal(result.backups[item.relPath])}>备份</Button>}</div>)}</div>
      {result?.manifestError && <p className="gen-error">文件写入结果已保留，但清单保存失败：{result.manifestError}</p>}
      {(result?.failed ?? 0) > 0 && <p className="gen-note">成功项已保留。关闭结果后更新产物，检查失败项再重试。</p>}
      <footer className="gen-modal-actions"><Button size="sm" variant="outline" disabled={!result?.written} onClick={() => onReveal(root)}>打开目录</Button>
        <Button size="sm" variant="outline" disabled={!result?.manifest} onClick={() => result && onReveal(result.manifest)}>定位清单</Button><Button size="sm" onClick={onCloseResult}>完成</Button></footer>
    </Modal>
  </>;
}
