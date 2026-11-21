import type { ReactNode } from "react";
import { useDelayedBusy } from "../../hooks/useDelayedBusy";
import { useTaskElapsed } from "../../hooks/useTaskElapsed";
import { WAIT_FEEDBACK } from "../../lib/motion";
import { Button } from "./button";

export interface TaskFeedbackProps {
  active: boolean;
  label: string;
  detail?: ReactNode;
  startedAt?: number;
  operationKey?: string | number;
  progress?: { done: number; total?: number; unit?: string };
  onCancel?: () => void;
  cancelling?: boolean;
  cancelLabel?: string;
  children?: ReactNode;
  className?: string;
  compact?: boolean;
}

/** Presentation only: progress, cancellation and outcomes always come from the task. */
export function TaskFeedback({ active, label, detail, startedAt, operationKey, progress, onCancel,
  cancelling = false, cancelLabel = "取消", children, className = "", compact = false }: TaskFeedbackProps) {
  const identity = operationKey ?? startedAt;
  const visible = useDelayedBusy(active, identity);
  const seconds = useTaskElapsed(active, startedAt, identity);
  if (!active) return null;
  const done = progress && Number.isFinite(progress.done) ? Math.max(0, progress.done) : undefined;
  const total = progress?.total;
  const determinate = done !== undefined && total !== undefined && Number.isFinite(total) && total > 0;
  const fraction = determinate ? Math.min(1, done / total) : undefined;
  return <div className={`ui-task-feedback ${className}`} data-visible={visible || undefined}
    data-compact={compact || undefined} data-waiting-long={seconds >= WAIT_FEEDBACK.long / 1000 || undefined}>
    <div className="ui-task-summary">
      <span className="ui-task-message" role="status" aria-atomic="true">
        <span className="op-wait-dot" data-live={visible && !cancelling && !determinate || undefined} aria-hidden="true" />
        <span>{cancelling ? "正在取消，等待任务确认…" : label}</span>
      </span>
      {seconds >= 1 && <span className="ui-task-elapsed" aria-live="off">已用 {seconds} 秒</span>}
      {onCancel && <Button type="button" variant="ghost" size="sm" disabled={cancelling} onClick={onCancel}>
        {cancelling ? "取消中…" : cancelLabel}
      </Button>}
      {children}
    </div>
    {(detail || done !== undefined) && <div className="ui-task-detail">
      {detail && <span>{detail}</span>}
      {done !== undefined && <span>{done}{determinate ? ` / ${total}` : ""}{progress?.unit ? ` ${progress.unit}` : ""}</span>}
    </div>}
    {!compact && seconds >= WAIT_FEEDBACK.long / 1000 && <p className="ui-task-wait-note">
      {cancelling ? "仍在等待任务确认取消。" : "任务仍在进行，完成后将显示结果。"}
    </p>}
    {!compact && <div className="ui-task-track" role="progressbar" aria-label={label}
      aria-valuemin={determinate ? 0 : undefined} aria-valuemax={determinate ? total : undefined}
      aria-valuenow={determinate ? Math.min(done, total) : undefined}>
      <span data-indeterminate={!determinate || undefined} style={fraction === undefined ? undefined : { transform: `scaleX(${fraction})` }} />
    </div>}
  </div>;
}
