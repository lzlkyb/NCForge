import { useMemo } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { formatBytes, resourceFriendlyError, type PackSummary, type ResourceErrorCode, type ResourcePhase } from "../../lib/resource";

/**
 * 资源初始化对话框（方案 B 首启引导）。
 *
 * 为什么需要它：jdtls / ecj / svnkit 这类大块资源不再随安装包分发
 * （安装包从 63.8MB 砍到 ~8MB），首次启动时按需下载。没有它们编译与
 * 代码智能不可用，所以下载状态必须可见、可感知进度，而不是默默转圈。
 *
 * 交互约定：
 *  - available 到达即自动开始下载（后端 ensure_packs 一路编排到底），本框不设
 *    「开始下载」按钮——用户没有别的路可走，多一步确认只是噪音；
 *  - Esc / 点遮罩可关（仅本会话抑制，下载在后台继续，设置页可随时重下）；
 *  - 失败时停在本框，给「重试」与原始错误（供用户反馈时复制）。
 */
export function ResourceSetupDialog({
  missing,
  totalBytes,
  phase,
  currentId,
  downloadedBytes,
  totalBytesCurrent,
  bytesPerSec,
  partialInstalled,
  error,
  errorCode,
  onRetry,
  onDismiss,
}: {
  missing: PackSummary[];
  totalBytes: number;
  phase: ResourcePhase;
  currentId: string | null;
  downloadedBytes: number;
  totalBytesCurrent: number | null;
  bytesPerSec: number;
  /** 失败前已完成的部分（error 事件带回）：这些行显示对勾，错误区显示「N/3 已就绪」 */
  partialInstalled: { id: string; version: string }[];
  error: string | null;
  errorCode: ResourceErrorCode | null;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const friendly = error ? resourceFriendlyError(error, errorCode) : null;

  // 总体进度：已完成的包（排在当前包之前的）+ 当前包已下载字节。
  // missing 顺序即后端下载顺序（ensure_packs 按 needed 数组逐包下）。
  const overall = useMemo(() => {
    if (phase !== "downloading" || !currentId) return null;
    const idx = missing.findIndex((p) => p.id === currentId);
    if (idx < 0) return null;
    const doneBytes = missing.slice(0, idx).reduce((sum, p) => sum + p.size, 0);
    const done = doneBytes + downloadedBytes;
    const percent = totalBytes > 0 ? Math.min(100, Math.round((done / totalBytes) * 100)) : null;
    return { done, percent };
  }, [phase, currentId, missing, downloadedBytes, totalBytes]);

  return (
    <Modal
      open
      onClose={onDismiss}
      ariaLabel="组件初始化"
      className="modal-surface w-[min(520px,92vw)]"
      closeOnOverlay
    >
      <div className="flex flex-col gap-4 p-6">
        <header className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Icon name="package" size={20} aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-0.5">
            <h2 className="text-base font-medium">准备组件</h2>
            <p className="text-xs text-muted-foreground">
              编译与代码智能所需的组件未随安装包分发，需联网下载一次（共 {formatBytes(totalBytes)}），之后不再需要。
            </p>
          </div>
        </header>

        <ul className="flex flex-col gap-2">
          {missing.map((pack) => {
            const active = phase === "downloading" && currentId === pack.id;
            return (
              <li
                key={pack.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                  active ? "border-primary/40 bg-primary/5" : "border-border"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {pack.title}
                    <span className="text-xs font-normal text-muted-foreground">{formatBytes(pack.size)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{pack.notes}</div>
                </div>
                <PackRowState
                  active={active}
                  done={!active && partialInstalled.some((p) => p.id === pack.id)}
                  downloaded={active ? downloadedBytes : 0}
                  total={active ? totalBytesCurrent : null}
                  indeterminate={active && totalBytesCurrent == null}
                />
              </li>
            );
          })}
        </ul>

        {phase === "downloading" && overall && (
          <div className="flex flex-col gap-1.5">
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${overall.percent ?? 0}%` }}
                role="progressbar"
                aria-valuenow={overall.percent ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="组件下载进度"
              />
            </div>
            <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
              <span>
                {formatBytes(overall.done)} / {formatBytes(totalBytes)}
              </span>
              <span>{bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "计算速率中…"}</span>
            </div>
          </div>
        )}

        {phase === "checking" && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon name="spinner" size={14} aria-hidden="true" />
            正在准备组件…
          </p>
        )}

        {phase === "error" && friendly && (
          <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
            <p className="flex items-center gap-2 text-xs text-destructive-ink">
              <Icon name="alertTriangle" size={14} aria-hidden="true" />
              {friendly.friendly}
            </p>
            {partialInstalled.length > 0 && (
              <p className="text-xs text-muted-foreground">
                已就绪 {partialInstalled.length}/{missing.length} 个组件，重试将跳过已完成的包。
              </p>
            )}
            {error && error !== friendly.friendly && (
              <p className="break-all text-[11px] text-muted-foreground">{error}</p>
            )}
          </div>
        )}

        <footer className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            下载会在后台继续；关闭后，组件就绪前编译不可用。
          </p>
          {phase === "error" ? (
            <Button size="sm" onClick={onRetry}>
              <Icon name="refresh" size={14} aria-hidden="true" />
              重试
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onDismiss}>
              关闭
            </Button>
          )}
        </footer>
      </div>
    </Modal>
  );
}

/** 单包行尾状态：已完成显示对勾；下载中显示百分比（或不确定态），其余状态由列表项自身表达。 */
function PackRowState({
  active,
  done,
  downloaded,
  total,
  indeterminate,
}: {
  active: boolean;
  done: boolean;
  downloaded: number;
  total: number | null;
  indeterminate: boolean;
}) {
  if (done) return <Icon name="check" size={15} className="shrink-0 text-primary" aria-hidden="true" />;
  if (!active) return <Icon name="clock" size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />;
  if (indeterminate || total == null) {
    return <Icon name="spinner" size={15} className="shrink-0 text-primary" aria-hidden="true" />;
  }
  const percent = Math.min(100, Math.round((downloaded / total) * 100));
  return <span className="shrink-0 text-xs tabular-nums text-primary">{percent}%</span>;
}
