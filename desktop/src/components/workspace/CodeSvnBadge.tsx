import { letterTone, svnStatusLabel, type StatusLetter } from "../../lib/svn";
import "../../svn-status-badge.css";

export function CodeSvnBadge({ status, onOpen, tabIndex }: { status: StatusLetter; onOpen?: () => void; tabIndex?: number }) {
  const label = svnStatusLabel[status];
  const hint = status === "A" ? "已加入 SVN，等待提交" : status === "?" ? "尚未加入 SVN" : label;
  if (onOpen) return <button
    type="button"
    tabIndex={tabIndex}
    className="vc-badge vc-badge-label wb-svn-badge-action"
    data-st={letterTone(status)}
    title={`${hint} · 点击查看 SVN 改动`}
    aria-label={`查看 SVN 改动（${label}）`}
    onClick={event => { event.stopPropagation(); onOpen(); }}
    onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}
  >{label}</button>;
  return <span className="vc-badge vc-badge-label" data-st={letterTone(status)} title={`SVN · ${hint}`}>{label}</span>;
}
