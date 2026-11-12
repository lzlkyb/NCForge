import { updatePresentation, updatePrimaryAction } from "../../lib/updatePresentation";
import { useEffect, useRef, type ReactNode } from "react";
import { useUpdate, friendlyError } from "../../contexts/UpdateContext";
import { useToast } from "../ui/toast";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/Spinner";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";
import "../update/update-badge.css";

/** 定宽槽位只负责提示和打开详情，下载安装始终在更新弹框中确认。 */
export function UpdateBadge({ currentVersion }: { currentVersion?: string }) {
  const state = useUpdate();
  const primary = updatePrimaryAction(state);
  const { status, update, progress, progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes,
    preparing, restarting, notesOpen, error, errorCode, errorToastAllowed,
    manualCheckForUpdate, manualCheck, acknowledgeUptodate } = state;
  const { toast } = useToast();
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev === status) return;
    if (status === "uptodate" && manualCheck) {
      toast("已是最新版本", "success");
      acknowledgeUptodate();
    } else if (status === "error" && errorToastAllowed && !notesOpen) {
      toast(error ? friendlyError(error, errorCode).friendly : "更新暂未完成，请重试", "error");
    }
  }, [status, notesOpen, toast, manualCheck, acknowledgeUptodate, error, errorCode, errorToastAllowed]);

  const pct = Math.min(100, Math.max(0, progress));
  if (status === "idle") return <Slot>{currentVersion && <button type="button" className="header-badge header-badge-idle" title={`v${currentVersion} · 点击检查更新`} aria-label={`v${currentVersion} · 点击检查更新`} onClick={() => void manualCheckForUpdate()}><span>v{currentVersion}</span></button>}</Slot>;
  if (status === "checking") return <Slot><span className="header-badge header-badge-checking" title={state.tryingBackup ? "正在尝试备用更新源" : "正在检查更新…"}><Spinner size={10} /><span>{state.tryingBackup ? "换源中" : "检查中"}</span></span></Slot>;
  if (status === "uptodate") return <Slot><button type="button" className="header-badge header-badge-uptodate" title="已是最新版本 · 点击检查更新" aria-label="已是最新版本 · 点击检查更新" onClick={() => void manualCheckForUpdate()}><Icon name="check" size={10} /><span>最新</span></button></Slot>;

  const dl = totalBytes ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}` : `${formatBytes(downloadedBytes)} 已下载`;
  const speed = bytesPerSec > 0 ? ` · ${formatBytesPerSec(bytesPerSec)}` : "";
  const presentation = updatePresentation({status,progress,progressIndeterminate,preparing,restarting,error,version:update?.version});
  const direct = !preparing && !restarting && ["ready", "available", "error"].includes(status);
  const label = direct ? primary.label : presentation.label;
  const title = direct
    ? [label, update?.version && `v${update.version}`, state.installBlock].filter(Boolean).join(" · ")
    : presentation.title + (status === "downloading" ? `${speed} · ${dl}` : "");
  const variant = status === "available" ? "update" : status === "ready" && error ? "error" : status === "installing" ? "downloading" : status;
  return <Slot><button type="button" className={`header-badge header-badge-${variant}`} title={title} aria-label={title} disabled={preparing} onClick={() => void primary.run()}>
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
