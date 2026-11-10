import { updatePresentation } from "../../lib/updatePresentation";
import { useUpdate } from "../../contexts/UpdateContext";
import { Icon, type IconName } from "../ui/icon";
import { Spinner } from "../ui/Spinner";
import "../update/update-badge.css";

/** 只有这几种状态才算「确实有更新」：空闲/检查中/已是最新一律不占位。 */
const SHOWN = new Set(["available", "downloading", "ready", "installing", "error"]);

/**
 * 折叠态（图标栏）的更新入口：foot 里一行常规 rail 项，与「设置」同构。
 *
 * 为什么不再用压在齿轮右上角的状态点：那是个 8px 视觉元素 + 22×22 热区，与设置
 * 自身的 changelog 红点共用「小红点 = 有未读」的视觉语言，用户第一反应是「设置里
 * 有未读」而不是「有新版本」；折叠态又没有文字兜底（`.app-side-label` 里那两个字
 * 被隐藏），只能靠 title 悬停才知道。改成独立一行后，图标 + 11px 文字与其他导航项
 * 一致，状态直接写在文字上（42% / 安装 / 重试）。
 *
 * 🔴 **只在真有更新时渲染**（SHOWN）。空闲态放一个「更新」入口虽然能当手动检查的
 *   按钮，但会变成常驻的第 5 个导航项 —— 折叠栏本来就只有图标+两字，多一项会挤掉
 *   真正的页面入口，且用户点它多半是想「看看有没有新版」而不是「现在就要更新」。
 *   手动检查仍在展开态的版本徽章与设置页里。
 *
 * 不渲染时 foot **不增高**：本项排在设置行上方，出现时只是把 foot 顶边往上推，
 * 设置行与其下元素原地不动，导航区少一行的空白 —— 没有横向或纵向位移。
 *
 * 与旧点一致：任何阶段都只打开详情，不直接下载/安装 —— 避免 ready 态误触重启。
 */
export function UpdateRailItem() {
  const { status, update, progress, progressIndeterminate, preparing, restarting, error, openUpdateNotes } = useUpdate();
  if (!SHOWN.has(status)) return null;

  const downloading = status === "downloading";
  const pct = Math.min(100, Math.max(0, progress));

  const {label, title} = updatePresentation({status,progress,progressIndeterminate,preparing,restarting,error,version:update?.version});

  // tone 只落在图标上：`.app-side-item:hover` 会把按钮 color 改成前景色，挂在按钮上会被
  // hover 冲掉，状态色就一闪一闪。
  const tone = status === "available" || downloading ? "primary" : status === "ready" ? error ? "danger" : "success" : status === "error" ? "danger" : undefined;

  return (
    <button
      type="button"
      className="app-side-item app-side-update"
      data-status={status}
      data-tone={tone}
      aria-label={title}
      title={title}
      disabled={preparing}
      onClick={openUpdateNotes}
    >
      <span className="app-side-update-icon">
        {downloading ? <ProgressRing progress={pct} indeterminate={progressIndeterminate} />
          : status === "installing" ? <Spinner size={17} />
          : <Icon name={iconFor(status)} size={19} />}
      </span>
      <span className="app-side-label">{label}</span>
    </button>
  );
}

function iconFor(status: string): IconName {
  if (status === "ready") return "check";
  if (status === "error") return "alertTriangle";
  return "download";
}

function ProgressRing({ progress, indeterminate }: { progress: number; indeterminate: boolean }) {
  const r = 7.2, c = 2 * Math.PI * r;
  return (
    <svg width={19} height={19} viewBox="0 0 19 19" className={indeterminate ? "animate-spin" : ""} aria-hidden="true">
      <circle cx={9.5} cy={9.5} r={r} fill="none" stroke="currentColor" strokeOpacity={0.23} strokeWidth={2.4} />
      <circle cx={9.5} cy={9.5} r={r} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={indeterminate ? c * 0.42 : c * (1 - progress / 100)} transform="rotate(-90 9.5 9.5)" />
    </svg>
  );
}
