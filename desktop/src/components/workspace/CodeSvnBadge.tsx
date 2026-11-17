import { letterTone, svnStatusLabel, type StatusLetter } from "../../lib/svn";
import "../../svn-status-badge.css";

const overlayGlyph: Partial<Record<ReturnType<typeof letterTone>, string>> = {
  add: "M4 1v6M1 4h6",
  del: "M1 4h6",
  conflict: "M4 1v3M4 6v.1",
};

export function CodeSvnBadge({ status, onOpen, tabIndex, overlay }: { status: StatusLetter; onOpen?: () => void; tabIndex?: number; overlay?: boolean }) {
  const label = svnStatusLabel[status];
  const hint = status === "A" ? "已加入 SVN，等待提交" : status === "?" ? "尚未加入 SVN" : label;
  const tone = letterTone(status);
  if (onOpen) return <button
    type="button"
    tabIndex={tabIndex}
    className="vc-badge vc-badge-label wb-svn-badge-action"
    data-st={tone}
    title={`${hint} · 点击查看 SVN 改动`}
    aria-label={`查看 SVN 改动（${label}）`}
    onClick={event => { event.stopPropagation(); onOpen(); }}
    onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}
  >{label}</button>;
  if (overlay) {
    const glyph = overlayGlyph[tone];
    return <span className="wb-svn-overlay" data-st={tone} title={status === "M" ? "有未提交的本地修改" : `SVN · ${hint}`}>
      {glyph && <svg width="7" height="7" viewBox="0 0 8 8" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d={glyph} /></svg>}
    </span>;
  }
  return <span className="vc-badge vc-badge-label" data-st={tone} title={`SVN · ${hint}`}>{label}</span>;
}
