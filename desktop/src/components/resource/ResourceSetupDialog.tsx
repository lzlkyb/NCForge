import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { formatBytes, resourceBusy, resourceFriendlyError, RESOURCE_PHASE_TEXT, type PackSummary, type PackStatusInfo, type ResourceErrorCode, type ResourcePhase } from "../../lib/resource";
import { ResourceDownloadReadout } from "./ResourceDownloadReadout";

interface ResourceSetupDialogProps {
  open: boolean;
  packs: PackStatusInfo[]; batch: PackSummary[]; requestedIds: string[];
  phase: ResourcePhase; currentId: string | null; downloadedBytes: number;
  totalBytesCurrent: number | null; bytesPerSec: number;
  lastInstalled: { id: string; version: string }[];
  error: string | null; errorCode: ResourceErrorCode | null;
  onDownload: (force?: boolean, ids?: string[]) => Promise<void>;
  onRetry: (ids?: string[]) => void; onDismiss: () => void;
}

/** 面板可随时关闭/重开，保留本轮下载与已安装组件，不影响后台任务。 */
export function ResourceSetupDialog(props: ResourceSetupDialogProps) {
  const { packs, batch, requestedIds, phase, currentId, lastInstalled, error, errorCode, onDownload, onRetry, onDismiss } = props;
  const busy = resourceBusy(phase);
  const rows = batch.length ? batch : packs.map(p => ({ ...p, size: p.size ?? 0 }));
  const friendly = error ? resourceFriendlyError(error, errorCode) : null;
  const done = rows.filter(p => lastInstalled.some(installed => installed.id === p.id)).length;
  const missingIds = packs.filter(p => p.state === "missing").map(p => p.id);
  return <Modal open={props.open} onClose={onDismiss} ariaLabel="运行组件下载" className="modal-surface w-[min(560px,92vw)]" closeOnOverlay>
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon name="package" size={20} aria-hidden="true" /></div>
        <div className="min-w-0 flex-1"><h2 className="text-base font-medium">运行组件下载</h2>
          <p className="mt-1 text-xs text-muted-foreground">按需要下载编译、代码智能、版本控制或反编译组件；各组件独立，下载后保存在本机。</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="关闭组件下载面板" onClick={onDismiss}><Icon name="close" size={16} aria-hidden="true" /></Button>
      </header>
      {requestedIds.length > 0 && <p className="text-xs text-muted-foreground" role="status">本轮 {requestedIds.length} 个组件 · 已就绪 {done}/{rows.length} · {RESOURCE_PHASE_TEXT[phase]}</p>}
      <ul className="resource-download-list">
        {rows.map(pack => {
          const installed = packs.find(p => p.id === pack.id)?.state !== "missing" && packs.some(p => p.id === pack.id);
          const complete = lastInstalled.some(p => p.id === pack.id);
          const unfinished = ["error", "ready"].includes(phase) && requestedIds.includes(pack.id) && !complete;
          const active = busy && currentId === pack.id;
          const waiting = busy && !complete;
          return <li key={pack.id} className="resource-download-row">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">{pack.title}<span className="text-xs font-normal text-muted-foreground">{pack.size > 0 ? formatBytes(pack.size) : "下载时获取大小"}</span></div>
              <p className="mt-1 text-xs text-muted-foreground">{pack.notes}</p>
            </div>
            {complete ? <span className="inline-flex items-center gap-1 text-xs text-primary"><Icon name="check" size={15} aria-hidden="true" />已就绪</span>
              : waiting ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Icon name={active ? "spinner" : "clock"} size={14} className={active ? "animate-spin" : undefined} aria-hidden="true" />{active ? RESOURCE_PHASE_TEXT[phase] : "等待下载"}</span>
                : <Button variant={installed ? "outline" : "default"} size="sm" aria-label={`${unfinished ? "重试下载" : installed ? "重新下载" : "下载"}${pack.title}`} disabled={busy}
                  onClick={() => unfinished ? onRetry([pack.id]) : void onDownload(!!installed, [pack.id])}>{unfinished ? "重试" : installed ? "重新下载" : "下载"}</Button>}
          </li>;
        })}
      </ul>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">正在读取本地组件状态，请稍候。</p>}
      <ResourceDownloadReadout {...props} title={rows.find(p => p.id === currentId)?.title} />
      {phase === "error" && friendly && <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
        <p className="flex items-center gap-2 text-xs text-destructive-ink"><Icon name="alertTriangle" size={14} aria-hidden="true" />{friendly.friendly}</p>
        {done > 0 && <p className="text-xs text-muted-foreground">已完成的组件会保留，重试只下载本轮剩余组件。</p>}
        {error !== friendly.friendly && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">错误详情</summary><p className="mt-2 break-all">{error}</p></details>}
      </div>}
      {phase === "ready" && <p className="inline-flex items-center gap-2 text-xs text-primary" role="status"><Icon name="check" size={14} aria-hidden="true" />{done < requestedIds.length ? "本次下载已完成，可继续重试剩余组件。" : "所选组件已就绪，可返回对应功能继续操作。"}</p>}
      <footer className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{busy ? "关闭后下载继续，可随时从顶栏重开。" : "未下载的组件仅影响对应功能。"}</p>
        {!busy && requestedIds.length > done ? <Button size="sm" onClick={() => onRetry()}><Icon name="refresh" size={14} aria-hidden="true" />重试剩余组件</Button>
          : !busy && missingIds.length > 0 ? <Button variant="outline" size="sm" onClick={() => void onDownload(false, missingIds)}>下载缺失组件（{missingIds.length}）</Button>
            : <Button variant="outline" size="sm" onClick={onDismiss}>{busy ? "后台继续" : "完成"}</Button>}
      </footer>
    </div>
  </Modal>;
}
