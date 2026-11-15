import type { ReactNode } from "react";
import { useDelayedBusy } from "../../hooks/useDelayedBusy";
import { Skeleton } from "./Skeleton";

/** One announcement per loading region; skeleton blocks remain decorative. */
export function LoadingState({ label = "正在加载…", className = "", children }: {
  label?: string; className?: string; children?: ReactNode;
}) {
  const visible = useDelayedBusy(true);
  return <div className={`ui-loading-state ${className}`} data-visible={visible || undefined}>
    <span className="sr-only" role="status">{label}</span>
    <div className="ui-loading-blocks" aria-busy="true" aria-hidden="true">{children ?? <>
      <Skeleton className="h-3 w-2/5" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-3/4" />
    </>}</div>
  </div>;
}
