import { useEffect, type RefObject } from "react";

/** 旧 WebView 的淡入回退直接作用于实际内容框，不重挂编辑器，也不移动输入位置。 */
export function WorkspacePageMotion({ page, target }: { page: string; target: RefObject<HTMLDivElement> }) {
  useEffect(() => {
    const element = target.current;
    if (!element?.animate || typeof document.startViewTransition === "function" || document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const style = getComputedStyle(document.documentElement);
    const timing = style.getPropertyValue("--dur-page").trim();
    const value = Number.parseFloat(timing);
    if (!Number.isFinite(value)) return;
    const animation = element.animate([{ opacity: .45 }, { opacity: 1 }], {
      duration: timing.endsWith("ms") ? value : value * 1000,
      easing: style.getPropertyValue("--ease").trim() || "ease-out",
    });
    void animation.finished.catch(() => {});
    return () => animation.cancel();
    // page 只负责触发短淡入，内容及其草稿始终保留在原节点。
  }, [page, target]);
  return null;
}
