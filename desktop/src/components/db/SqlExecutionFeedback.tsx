import { Icon } from "../ui/icon";
import { thousands } from "../../lib/db";
import { useTaskElapsed } from "../../hooks/useTaskElapsed";
import { useActiveOperation, useOperationById } from "../../lib/operations";
import { useViewActive } from "../../lib/viewActivity";

/** Isolate the clock from the editor, grid and live region. */
export function QueryElapsed({ startedAt }: { startedAt: number }) {
  const seconds = useTaskElapsed(useViewActive(), startedAt, startedAt);
  return <span className="dbx-query-time" aria-live="off"> · 已用 {seconds} 秒</span>;
}

/** Execution status belongs to the existing result header, not a separate row. */
export function SqlExecutionFeedback({ tabId, executionId, previousAt }: { tabId?: string; executionId?: number; previousAt?: number }) {
  const execution = useActiveOperation(tabId ? "db.sql:" + tabId : "");
  const explain = useActiveOperation(tabId ? "db.explain:" + tabId : "");
  const resultOperation = useOperationById(executionId);
  const operation = execution ?? explain ?? resultOperation;
  if (!operation) return <span className="dbx-query-status" aria-hidden="true" />;
  const active = operation.endedAt === undefined;
  const progress = operation.progress;
  const script = (progress?.total ?? 0) > 1;
  const cost = operation.endedAt === undefined ? 0 : Math.max(0, operation.endedAt - operation.startedAt);
  const old = previousAt !== undefined && previousAt < operation.startedAt;
  const text = active
    ? operation.state === "cancelling" ? "等待数据库停止确认"
      : script ? `执行脚本 · ${thousands(progress?.done ?? 0)} / ${thousands(progress?.total ?? 0)} 条`
      : operation.phase
    : operation.state === "cancelled" ? operation.detail?.startsWith("连接未建立") ? "未执行 · 连接未建立" : "执行已停止"
      : operation.state === "failed" ? script ? "脚本执行有失败" : "执行失败"
        : script ? "脚本执行完成" : "执行完成";
  return <span className="dbx-query-status" data-state={operation.state} title={operation.detail ?? (text + (active && old ? " · 上次结果" : ""))}>
    {active ? <span className="op-wait-dot" data-live={operation.visible && operation.state === "running" || undefined} aria-hidden="true" /> : <Icon name={operation.state === "success" ? "check" : operation.state === "failed" ? "alert" : "stop"} size={12} />}
    <span className="dbx-query-status-text" role="status">{text}
      {active && old && " · 上次结果"}
      {!active && script && progress && ` · 已处理 ${thousands(progress.done)} / ${thousands(progress.total ?? 0)} 条`}
      {!active && !script && cost > 0 && ` · ${cost < 1000 ? `${Math.round(cost)}ms` : `${(cost / 1000).toFixed(1)}s`}`}
    </span>
    {active && operation.visible && <QueryElapsed startedAt={operation.startedAt}/>}
  </span>;
}
