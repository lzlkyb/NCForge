import { useEffect, useRef, type ReactNode } from "react";
import { useUpdate, friendlyError } from "../../contexts/UpdateContext";
import { useToast } from "../ui/toast";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/Spinner";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";
import "../update/update-badge.css";

/** 定宽槽位只负责提示和打开详情，下载安装始终在更新弹框中确认。 */
export function UpdateBadge({ currentVersion }: { currentVersion?: string }) {
  const { status, update, progress, progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes,
    preparing, restarting, notesOpen, error, errorCode, errorToastAllowed,
    manualCheckForUpdate, openUpdateNotes, manualCheck, acknowledgeUptodate } = useUpdate();
  const { toast } = useToast();
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev === status) return;
    // 新版本由自动弹框说明；只在后台下载完成时补一条可行动的通知。
    if (status === "ready" && prev === "downloading" && !notesOpen) {
      toast("更新包已下载并验证，准备好后可确认安装并重启", "success");
    } else if (status === "uptodate" && manualCheck) {
      toast("已是最新版本", "success");
      acknowledgeUptodate();
    } else if (status === "error" && errorToastAllowed && !notesOpen) {
      toast(error ? friendlyError(error, errorCode).friendly : "更新暂未完成，请重试", "error");
    }
  }, [status, notesOpen, toast, manualCheck, acknowledgeUptodate, error, errorCode, errorToastAllowed]);

  const pct = Math.min(100, Math.max(0, progress));
  if (status === "idle") return <Slot>{currentVersion && <button type="button" className="header-badge header-badge-idle" title={`v${currentVersion} · 点击检查更新`} aria-label={`v${currentVersion} · 点击检查更新`} onClick={() => void manualCheckForUpdate()}><span>v{currentVersion}</span></button>}</Slot>;
  if (status === "checking") return <Slot><span className="header-badge header-badge-checking" title="正在检查更新…"><Spinner size={10} /><span>检查中</span></span></Slot>;
  if (status === "uptodate") return <Slot><button type="button" className="header-badge header-badge-uptodate" title="已是最新版本 · 点击检查更新" aria-label="已是最新版本 · 点击检查更新" onClick={() => void manualCheckForUpdate()}><Icon name="check" size={10} /><span>最新</span></button></Slot>;

  const dl = totalBytes ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}` : `${formatBytes(downloadedBytes)} 已下载`;
  const speed = bytesPerSec > 0 ? ` · ${formatBytesPerSec(bytesPerSec)}` : "";
  const label = preparing ? "检查中" : status === "downloading" ? progressIndeterminate ? "下载中" : `${pct}%` : status === "ready" ? "安装" : status === "installing" || restarting ? "安装中" : status === "error" ? "重试" : "更新";
  const title = preparing ? "正在检查当前工作" : status === "downloading" ? `正在下载更新 · ${progressIndeterminate ? "总大小未知" : `${pct}%`}${speed} · ${dl} · 点击查看进度` : status === "ready" ? "更新包已下载并验证，点击查看并确认安装重启" : status === "installing" || restarting ? "正在安装并重启，点击查看详情" : status === "error" ? `${error ? friendlyError(error, errorCode).friendly : "更新暂未完成"} · 点击查看原因和重试` : `发现新版本 v${update?.version ?? ""}，点击查看更新详情`;
  const variant = status === "available" ? "update" : status === "installing" ? "downloading" : status;
  return <Slot><button type="button" className={`header-badge header-badge-${variant}`} title={title} aria-label={title} disabled={preparing} onClick={openUpdateNotes}>
    {preparing || status === "installing" || restarting ? <Spinner size={10} /> : status === "downloading" ? <DownloadRing progress={pct} indeterminate={progressIndeterminate} /> : <Icon name={status === "ready" ? "check" : status === "error" ? "alertTriangle" : "arrowUp"} size={10} aria-hidden="true" />}
    <span>{label}</span>
  </button></Slot>;
}

function Slot({ children }: { children?: ReactNode }) {
  return <span className="update-slot">{children}</span>;
}

function DownloadRing({ progress, indeterminate }: { progress: number; indeterminate: boolean }) {
  const r = 4.8, c = 2 * Math.PI * r;
  return <svg width={12} height={12} viewBox="0 0 12 12" className={indeterminate ? "animate-spin" : ""} aria-hidden="true">
    <circle cx={6} cy={6} r={r} fill="none" stroke="currentColor" strokeOpacity={.23} strokeWidth={2.4} />
    <circle cx={6} cy={6} r={r} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={indeterminate ? c * .42 : c * (1 - progress / 100)} transform="rotate(-90 6 6)" />
  </svg>;
}
