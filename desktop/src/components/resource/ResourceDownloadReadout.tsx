import { Icon } from "../ui/icon";
import { formatBytes, RESOURCE_PHASE_TEXT, type ResourcePhase } from "../../lib/resource";
import "./resource-download.css";

export interface ResourceDownloadReadoutProps {
  phase: ResourcePhase; currentId: string | null;
  downloadedBytes: number; totalBytesCurrent: number | null; bytesPerSec: number;
  title?: string;
}
export function ResourceDownloadReadout({ phase, currentId, downloadedBytes, totalBytesCurrent, bytesPerSec, title }: ResourceDownloadReadoutProps) {
  if (!["checking", "downloading", "verifying", "installing"].includes(phase)) return null;
  const transferring = phase === "downloading";
  const percent = transferring && totalBytesCurrent != null && totalBytesCurrent > 0
    ? Math.min(100, Math.max(0, Math.round(downloadedBytes / totalBytesCurrent * 100))) : null;
  return <div className="resource-download-readout" aria-busy="true">
    <div className="resource-download-meta" role="status">
      <span className="inline-flex items-center gap-1.5"><Icon name="spinner" size={14} className="animate-spin" aria-hidden="true" />
        {title ?? currentId ?? "运行组件"} · {RESOURCE_PHASE_TEXT[phase]}
      </span>
      <span>{percent != null ? `${percent}%` : transferring ? "总大小未知" : "请稍候"}</span>
    </div>
    <div className="resource-download-track" role="progressbar" aria-label="当前组件下载进度"
      aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100}
      aria-valuetext={transferring ? percent != null ? `${percent}%` : "总大小未知，正在下载" : RESOURCE_PHASE_TEXT[phase]}>
      <span className={percent == null ? "is-indeterminate" : undefined} style={percent != null ? { transform: `scaleX(${percent / 100})` } : undefined} />
    </div>
    {transferring ? <div className="resource-download-meta text-muted-foreground">
      <span>{formatBytes(downloadedBytes)} / {totalBytesCurrent != null && totalBytesCurrent > 0 ? formatBytes(totalBytesCurrent) : "大小未知"}</span>
      <span>{bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "计算速率中…"}</span>
    </div> : <p className="text-xs text-muted-foreground">
      {phase === "checking" ? "正在读取组件清单与本地状态。" : phase === "verifying" ? "下载已完成，正在校验文件完整性。" : "下载已完成，正在解压并安装组件。"}
    </p>}
  </div>;
}
