import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import { thousands } from "../../lib/db";
import { useAppHidden } from "../../lib/appVisibility";
import { getOperations, subscribeOperations } from "../../lib/operations";

/** The clock stays inside the stop button, so it never rerenders the result grid. */
export function QueryElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now);
  const hidden = useAppHidden();
  useEffect(() => {
    if (hidden) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [hidden, startedAt]);
  return <span className="dbx-query-time" aria-hidden="true"> · {(Math.max(0, now - startedAt) / 1000).toFixed(1)}s</span>;
}

/** Execution status belongs to the existing result header, not a separate row. */
export function SqlExecutionFeedback({ executionId, previousAt }: { executionId?: number; previousAt?: number }) {
  const operation = useSyncExternalStore(subscribeOperations, () => getOperations().find(op => op.id === executionId));
  if (!operation) return null;
  const active = operation.endedAt === undefined;
  const progress = operation.progress;
  const script = (progress?.total ?? 0) > 1;
  if (!active && !script && operation.state !== "cancelled" && operation.state !== "failed") return null;
  const old = previousAt !== undefined && previousAt < operation.startedAt;
  const text = active
    ? operation.state === "cancelling" ? "等待数据库停止确认"
      : script ? `执行脚本 · ${thousands(progress?.done ?? 0)} / ${thousands(progress?.total ?? 0)} 条`
      : old ? "正在重新查询 · 当前为上次结果" : operation.phase
    : operation.state === "cancelled" ? operation.detail?.startsWith("连接未建立") ? "未执行 · 连接未建立" : "执行已停止"
      : operation.state === "failed" ? script ? "脚本执行有失败" : "执行失败" : "脚本执行完成";
  return <span className="dbx-query-status" data-state={operation.state} role="status" title={operation.detail ?? text}>
    <Icon name={active ? "activity" : operation.state === "success" ? "check" : operation.state === "failed" ? "alert" : "stop"} size={12} />
    {text}{!active && script && progress && <span> · 已处理 {thousands(progress.done)} / {thousands(progress.total ?? 0)} 条</span>}
  </span>;
}
