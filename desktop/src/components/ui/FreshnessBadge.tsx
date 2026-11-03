import { useEffect, useState } from "react";
import { Icon } from "./icon";

export type FreshnessState = "loading" | "live" | "stale" | "error";

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 数据新鲜度徽标：一眼看清「这份结论是什么时候的、还能不能信」。
 *
 * 只靠「刷新」按钮无法表达三件事：正在扫描（旧数据还留在屏幕上）、扫描失败
 * （旧数据仍在）、数据已经放凉（五分钟前的 SVN 扫描不能当现在用）。徽标把
 * 这三种状态显式说出来，`live` 超过 `staleAfterMs` 自动翻成 `stale`。
 *
 * - `at` 为 null 且 `state="live"`：表示实时流（如 1 秒轮询的服务状态）。
 * - `onRefresh` 只在 error / stale 时渲染成重试按钮，避免和页面自己的刷新按钮重复。
 */
export function FreshnessBadge({
  state,
  at,
  label = "数据",
  staleAfterMs = 60_000,
  onRefresh,
  className = "",
}: {
  state: FreshnessState;
  at: number | null;
  label?: string;
  staleAfterMs?: number;
  onRefresh?: () => void;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (state !== "live" || at === null) return;
    const remaining = staleAfterMs - (Date.now() - at);
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const t = setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => clearTimeout(t);
  }, [state, at, staleAfterMs]);

  const cooled = state === "live" && at !== null && now - at > staleAfterMs;
  const tone = state === "error" ? "error" : state === "loading" ? "loading" : cooled ? "stale" : "live";
  const text =
    tone === "loading"
      ? `${label}更新中…`
      : tone === "error"
        ? `${label}更新失败`
        : at === null
          ? "实时"
          : tone === "stale"
            ? `${label}停在 ${clock(at)}`
            : `已更新 ${clock(at)}`;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-2 py-[1px] text-[11px] leading-4 ${
        tone === "error"
          ? "text-destructive-ink"
          : tone === "stale"
            ? "text-warning-ink"
            : "text-muted-foreground"
      } ${className}`}
      title={
        tone === "stale"
          ? `数据超过 ${Math.round(staleAfterMs / 1000)} 秒未更新`
          : at === null
            ? "实时数据"
            : `更新于 ${new Date(at).toLocaleString("zh-CN")}`
      }
      data-freshness={tone}
    >
      <span role="status" aria-live="polite" className="inline-flex items-center gap-1">
        {tone === "loading" ? (
          <Icon name="refresh" size={11} className="animate-spin" />
        ) : tone === "error" ? (
          <Icon name="alertTriangle" size={11} />
        ) : (
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              tone === "stale" ? "bg-warning" : "bg-success"
            }`}
            aria-hidden="true"
          />
        )}
        <span>{text}</span>
      </span>
      {(tone === "error" || tone === "stale") && onRefresh && (
        <button
          type="button"
          className="ml-0.5 rounded px-1 font-medium underline-offset-2 hover:underline focus-visible:underline"
          onClick={onRefresh}
        >
          重试
        </button>
      )}
    </span>
  );
}
