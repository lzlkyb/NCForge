import { friendlyError, type UpdateStatus } from "../../contexts/UpdateContext";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";
import { updateRetryLabel } from "../../lib/updatePresentation";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

export interface UpdateDialogProcess {
  status: UpdateStatus;
  progress: number;
  progressIndeterminate: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
  bytesPerSec: number;
  preparing: boolean;
  restarting: boolean;
  error: string | null;
  errorCode: string | null;
  failureStage?: "check" | "download";
  tryingBackup?: boolean;
  installBlock?: string | null;
  openInstallBlock?: () => void;
}

export const AVAILABLE_PROCESS: UpdateDialogProcess = {
  status: "available", progress: 0, progressIndeterminate: false, downloadedBytes: 0,
  totalBytes: null, bytesPerSec: 0, preparing: false, restarting: false, error: null, errorCode: null,
};

export function updateProcessTitle(process: UpdateDialogProcess) {
  if (process.preparing) return "安装前，检查当前工作";
  const titles: Record<UpdateStatus, string> = {
    idle: "软件更新", checking: "正在检查更新", available: "发现新版本",
    downloading: "正在下载更新", ready: "新版本已准备好",
    installing: "正在安装并重启", error: "更新暂未完成", uptodate: "当前已是最新版本",
  };
  return process.restarting ? "正在应用新版本" : process.status === "ready" && process.error ? "更新尚未完成，可以重试" : titles[process.status];
}

export function UpdateProcess({ process }: { process: UpdateDialogProcess }) {
  const { status, preparing, restarting } = process;
  if (status === "available" && !preparing) return null;
  const pct = Math.min(100, Math.max(0, process.progress));
  const verifying = status === "downloading" && pct >= 100 && !process.progressIndeterminate;
  const failed = status === "error" || (status === "ready" && !!process.error);
  return <section className="update-process" data-status={failed ? "error" : status} aria-label="更新状态">
    <div className="update-process-heading">
      <h3 role="status" aria-live="polite">
        <Icon name={failed ? "alertTriangle" : status === "ready" ? "check" : "refresh"} size={15} aria-hidden="true" />
        {preparing ? "正在检查未保存文件、数据库事务与运行任务…" : restarting || status === "installing" ? "正在启动安装器并应用更新…" : verifying ? "下载完成，正在校验更新包" : status === "downloading" ? "关闭弹框后仍会继续下载" : status === "ready" ? "更新包已下载并验证" : status === "checking" ? "正在重新检查更新…" : status === "error" ? "更新暂未完成" : "当前已是最新版本"}
      </h3>
      {status === "downloading" && <strong>{process.progressIndeterminate ? "下载中" : `${pct}%`}</strong>}
    </div>
    <p>{preparing ? "处理好当前工作后才会启动安装；取消后会留在工作台。" : status === "installing" || restarting ? "安装器可能关闭应用，请等待新版本启动。" : status === "ready" ? process.error ? "安装或重启尚未完成，更新包仍已准备好，可以再次尝试。" : "确认后才安装并重启，软件不会倒计时强制重启。" : status === "downloading" ? verifying ? "验签完成后等待你确认安装，不会自动关闭工作台。" : "可收起到后台，随时从更新徽章查看进度。" : status === "error" ? friendlyError(process.error ?? "", process.errorCode).friendly : status === "checking" ? "检查完成后显示最新结果。" : "可以继续工作，软件会在后台检查新的更新。"}</p>
    {process.tryingBackup && ["checking", "downloading"].includes(status) && <p role="status">正在尝试备用更新源…</p>}
    {process.installBlock && <p role="status">{process.installBlock} {process.openInstallBlock && <Button size="sm" variant="outline" onClick={process.openInstallBlock}>前往处理</Button>}</p>}
    {status === "downloading" && <>
      <div className="update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={process.progressIndeterminate ? undefined : pct} aria-valuetext={process.progressIndeterminate ? "总大小未知" : undefined}>
        <span className={process.progressIndeterminate ? "update-progress-unknown" : ""} style={process.progressIndeterminate ? undefined : { transform: `scaleX(${pct / 100})` }} />
      </div>
      <div className="update-download-metrics"><span>{formatBytes(process.downloadedBytes)}{process.totalBytes ? ` / ${formatBytes(process.totalBytes)}` : " · 总大小未知"}</span><span>{verifying ? "正在校验" : process.bytesPerSec > 0 ? formatBytesPerSec(process.bytesPerSec) : "正在连接…"}</span></div>
    </>}
    {failed && process.error && <details className="update-error-details"><summary>查看错误详情</summary><p>{process.error}</p></details>}
  </section>;
}

export function UpdateActions({ process, onClose, onDownload, onDismiss, onRestart, onRetry }: {
  process: UpdateDialogProcess; onClose: () => void; onDownload: () => void;
  onDismiss: () => void; onRestart?: () => void; onRetry?: () => void;
}) {
  const { status, preparing, restarting } = process;
  const blocked = preparing || restarting || status === "installing";
  const closeLabel = status === "downloading" ? "收起到后台" : status === "ready" ? "稍后" : status === "uptodate" || status === "idle" ? "完成" : "稍后提醒";
  return <footer className="update-dialog-footer">
    <p className="update-restart-note"><Icon name={status === "ready" ? "refresh" : "info"} size={14} aria-hidden="true" /><span>{status === "ready" ? "安装并重启前，会再次核对未保存文件、数据库事务和运行任务。" : "先后台下载并校验更新包，安装并重启由你确认。"}</span></p>
    <div className="update-dialog-actions">
      {status === "available" && <button key="ignore" type="button" disabled={blocked} className="interactive update-ignore" onClick={() => { onDismiss(); onClose(); }}>忽略此版本</button>}
      <Button key="close" variant="outline" disabled={blocked} onClick={onClose}>{closeLabel}</Button>
      {status === "available" && <Button key="primary" disabled={blocked} onClick={onDownload}><Icon name="download" size={15} aria-hidden="true" />{preparing ? "检查当前工作…" : "下载更新"}</Button>}
      {status === "downloading" && <Button key="primary" disabled><Icon name="download" size={15} aria-hidden="true" />{!process.progressIndeterminate && process.progress >= 100 ? "正在校验" : "正在下载"}</Button>}
      {status === "checking" && <Button key="primary" disabled>检查中…</Button>}
      {status === "error" && <Button key="primary" disabled={blocked || !onRetry} onClick={onRetry}><Icon name="refresh" size={15} aria-hidden="true" />{updateRetryLabel(process.failureStage, process.errorCode)}</Button>}
      {status === "ready" && <Button key="primary" disabled={blocked || !onRestart} onClick={onRestart}><Icon name="refresh" size={15} aria-hidden="true" />{preparing ? "检查当前工作…" : process.installBlock ? "继续安装" : process.error ? "重试安装" : "安装并重启"}</Button>}
      {status === "installing" && <Button key="primary" disabled><Icon name="refresh" size={15} aria-hidden="true" />正在安装…</Button>}
    </div>
  </footer>;
}
