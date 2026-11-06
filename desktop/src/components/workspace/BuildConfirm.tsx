import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { BuildConfirmState } from "../../hooks/useBuildMaintenance";

/**
 * 清理 / 重编 / 重建索引的统一确认框。
 *
 * 逐模块列出「删多少个、保留多少个」：只给总数的确认框在模块多的时候
 * 看不出到底动了哪几个模块。只有一条时上面的描述已经说清楚，不再重复列表。
 */
export function BuildConfirm({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: BuildConfirmState | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!pending) return null;
  return (
    <ConfirmDialog
      open
      title={pending.title}
      description={pending.description}
      confirmLabel={pending.confirmLabel}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {pending.reports.length > 1 && (
        <ul className="mb-1 max-h-40 overflow-auto rounded-md border border-border p-2 text-xs text-muted-foreground">
          {pending.reports.map((r) => (
            <li key={r.module} className="flex items-center justify-between gap-3">
              <span className="truncate">{r.module}</span>
              <span className="shrink-0">
                {r.removed} 个 class
                {r.failed.length > 0 ? ` · ${r.failed.length} 个失败` : ""}
                {r.unknownCount > 0 ? ` · 保留 ${r.unknownCount} 个` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ConfirmDialog>
  );
}
