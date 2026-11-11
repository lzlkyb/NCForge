import { useSyncExternalStore } from "react";
import {
  getEffectiveBaseline, getSnapshotFor, jumpChanged, subscribeBaseline, subscribeSnapshot,
} from "../../lib/changedLinesStore";
import { getSession } from "../../lib/workspaceSession";
import {
  getReviewState, openChecklist, openTimeline, reviewedCount, setBaselineMode,
  subscribeReviewSession,
} from "../../lib/reviewSession";

/**
 * 阅读工具行里的改动摘要。只在「这个文件有基线且有改动」时出现，不占常驻空间；
 * 全部走 useSyncExternalStore，不往 EditorPane 里塞新的 state/effect。
 *
 * 「核对」直调 store 函数（P0-1），不再派发一个可能无人接收的 window 事件。
 * 摘要同时给出「几块已审」与当前基线口径（P1-1 / S9），loading 也有反馈（P2）。
 */
export function ChangedLinesBar({ path }: { path: string | null }) {
  const snap = useSyncExternalStore(subscribeSnapshot, () => getSnapshotFor(path), () => getSnapshotFor(path));
  const baseline = useSyncExternalStore(subscribeBaseline, () => getEffectiveBaseline(path), () => getEffectiveBaseline(path));
  const review = useSyncExternalStore(subscribeReviewSession, getReviewState, getReviewState);
  if (!path || getSession().root === null) return null;
  if (baseline?.state === "loading") {
    return <span className="ncf-chg-bar ncf-chg-loading" role="status">正在读取基线…</span>;
  }
  if (baseline?.state !== "ok") return null;
  if (snap.tooBig) {
    return <span className="ncf-chg-bar ncf-chg-hint" role="status">文件过大，改动色条已暂停</span>;
  }
  if (snap.blocks.length === 0) return null;
  const done = reviewedCount(path, snap.blocks);
  const roundMode = review.baselineMode === "round";
  return (
    <span className="ncf-chg-bar" role="status" aria-live="polite">
      <span className="ncf-chg-summary">
        本文件 <b className="ncf-chg-plus">+{snap.added}</b> <b className="ncf-chg-minus">−{snap.removed}</b>
        <span className="ncf-chg-who"> · {roundMode && baseline.label !== "本轮前" ? "本轮无归档点 · 退化为 SVN 基线" : (baseline.label ?? "SVN 基线")}</span>
        <span className="ncf-chg-progress"> · {done}/{snap.blocks.length} 块已审</span>
      </span>
      {roundMode ? (
        <button type="button" className="ncf-chg-base" title="改看相对 SVN 基线全部未提交改动"
          onClick={() => void setBaselineMode("svn")}>切回 SVN 基线</button>
      ) : (
        <button type="button" className="ncf-chg-base" title="只看选中这一轮改了什么；没选轮会打开时间线"
          onClick={() => review.round ? void setBaselineMode("round") : openTimeline()}>
          {review.round ? "收敛到本轮" : "选一轮来审"}
        </button>
      )}
      <button type="button" className="ncf-chg-nav" title="上一处未审改动（Alt+↑）" aria-label="上一处未审改动" onClick={() => jumpChanged(-1)}>↑</button>
      <button type="button" className="ncf-chg-nav" title="下一处未审改动（Alt+↓）" aria-label="下一处未审改动" onClick={() => jumpChanged(1)}>↓</button>
      <button type="button" className="ncf-chg-nav ncf-chg-check" title="打开出包前审查清单" aria-label="打开审查清单"
        onClick={openChecklist}>核对</button>
    </span>
  );
}
