import { friendlyError, useUpdate } from "../../contexts/UpdateContext";
import "../update/update-badge.css";

/** 状态点与设置按钮保持独立；各更新阶段都只打开详情，避免误触安装或重启。 */
export function UpdateCollapsedDot() {
  const { status, progress, progressIndeterminate, error, errorCode, preparing, openUpdateNotes } = useUpdate();
  if (!["available", "downloading", "ready", "installing", "error"].includes(status)) return null;
  const downloading = status === "downloading";
  const pct = Math.min(100, Math.max(0, progress));
  const label = downloading ? `正在下载更新 · ${progressIndeterminate ? "总大小未知" : `${pct}%`}，点击查看进度` : status === "ready" ? "更新包已下载并验证，点击查看并确认安装重启" : status === "installing" ? "正在安装并重启，点击查看详情" : status === "error" ? `${error ? friendlyError(error, errorCode).friendly : "更新暂未完成"}，点击查看原因和重试` : "发现新版本，点击查看更新详情";
  const style = downloading ? "dl" : status === "installing" ? "ready" : status;
  return <button type="button" className={`upd-dot upd-dot--${style}`} title={label} aria-label={label} disabled={preparing} onClick={openUpdateNotes}>
    {downloading && <DotRing progress={pct} indeterminate={progressIndeterminate} />}
  </button>;
}

function DotRing({ progress, indeterminate }: { progress: number; indeterminate: boolean }) {
  const r = 4.4, c = 2 * Math.PI * r;
  return <svg width={11} height={11} viewBox="0 0 11 11" className={indeterminate ? "animate-spin" : ""} aria-hidden="true">
    <circle cx={5.5} cy={5.5} r={r} fill="none" stroke="currentColor" strokeOpacity={.23} strokeWidth={2.2} />
    <circle cx={5.5} cy={5.5} r={r} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={indeterminate ? c * .42 : c * (1 - progress / 100)} transform="rotate(-90 5.5 5.5)" />
  </svg>;
}
