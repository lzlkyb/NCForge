import { Skeleton } from "../ui/Skeleton";
import { useDelayedBusy } from "../../hooks/useDelayedBusy";

/** One announcement for the region; placeholder rows never enter the accessibility tree. */
export function MetaToolSkeleton({ label = "正在加载元数据工具…", view = "detail" }: { label?: string; view?: "detail" | "compare" | "history" | "generate" | "excel" | "publish" }) {
  const visible = useDelayedBusy(true);
  return <div className="meta-tool-skeleton" data-view={view} data-busy="true" data-visible={visible || undefined}>
    <span className="sr-only" role="status" aria-label={label}>{label}</span>
    <div className="meta-tool-skeleton-head" aria-hidden="true"><Skeleton className="meta-tool-skeleton-title" /><Skeleton className="meta-tool-skeleton-action" /></div>
    <div className="meta-tool-skeleton-body" aria-hidden="true" aria-busy="true">
      <div className="meta-tool-skeleton-list">{[0, 1, 2, 3, 4].map((row) => <Skeleton key={row} className="meta-tool-skeleton-row" />)}</div>
      <div className="meta-tool-skeleton-content"><Skeleton className="meta-tool-skeleton-title" />{[0, 1, 2, 3, 4].map((row) => <Skeleton key={row} className="meta-tool-skeleton-line" />)}</div>
      {view === "generate" && <div className="meta-tool-skeleton-files">{[0, 1, 2, 3, 4, 5].map(row => <Skeleton key={row} className="meta-tool-skeleton-row" />)}</div>}
    </div>
  </div>;
}
