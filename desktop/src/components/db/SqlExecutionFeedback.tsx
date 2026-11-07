import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import { thousands } from "../../lib/db";
import { useAppHidden } from "../../lib/appVisibility";
import { getOperations, subscribeOperations } from "../../lib/operations";

export function SqlExecutionFeedback({ executionId, previousAt }: { executionId?: number; previousAt?: number }) {
  const operation = useSyncExternalStore(subscribeOperations, () =>
    getOperations().find(op => op.id === executionId));
  const active = operation?.endedAt === undefined && !!operation;
  const visible = active && !!operation?.visible;
  const hidden = useAppHidden();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible || hidden) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [visible, hidden, operation?.id]);
  if (!operation) return null;
  const progress = operation.progress;
  const total = progress?.total ?? 0;
  if (active && (visible || operation.state === "cancelling")) {
    const script = total > 1;
    const elapsed = Math.max(0, now - operation.startedAt) / 1000;
    const text = operation.state === "cancelling" ? "正在停止 · 等待数据库返回"
      : script ? "执行脚本 · " + thousands(progress?.done ?? 0) + " / " + thousands(total) + " 条"
      : progress ? "等待数据库返回" : operation.phase;
    return <div className="dbx-execution-feedback" data-busy>
      <Icon name="clock" size={13} />
      <span role="status">{script && operation.state !== "cancelling" ? "正在执行脚本" : text}</span>
      {script && operation.state !== "cancelling" && <span>{thousands(progress?.done ?? 0)} / {thousands(total)} 条</span>}
      {previousAt !== undefined && previousAt < operation.startedAt && <span className="dbx-muted">上次结果</span>}
      <span className="dbx-sp" /><span className="dbx-muted">{elapsed.toFixed(1)} s</span>
      <span className="dbx-execution-track" aria-hidden="true" data-indeterminate={!script || undefined}>
        <i style={script ? { width: ((progress?.done ?? 0) / total * 100) + "%" } : undefined} />
      </span>
    </div>;
  }
  if (operation.state !== "cancelled" && (active || total <= 1)) return null;
  const text = operation.state === "cancelled" ? operation.detail?.startsWith("连接未建立") ? "未执行 · 连接未建立" : "执行已停止"
    : operation.state === "failed" ? "脚本执行有失败" : "脚本执行完成";
  return <div className="dbx-execution-feedback" data-state={operation.state} role="status">
    <Icon name={operation.state === "success" ? "check" : operation.state === "failed" ? "alert" : "stop"} size={13} />
    <span>{text}</span>{progress && <span>已处理 {thousands(progress.done)} / {thousands(total)} 条</span>}
  </div>;
}
