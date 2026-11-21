import { useEffect, useState } from "react";
import { useAppHidden } from "../../lib/appVisibility";
import { estimateText, type OperationEstimate } from "../../lib/operationEstimate";
import { useOperation, useOperationById } from "../../lib/operations";
import { useViewActive } from "../../lib/viewActivity";

export function OperationEta({ estimate }: { estimate?: OperationEstimate }) {
  const hidden = useAppHidden();
  const visible = useViewActive();
  const [expired, setExpired] = useState<number>();
  const validUntil = estimate?.validUntil;
  useEffect(() => {
    if (hidden || !visible || validUntil === undefined || expired === validUntil) return;
    const timer = window.setTimeout(() => setExpired(validUntil), Math.max(0, validUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expired, hidden, visible, validUntil]);
  const text = expired !== validUntil ? estimateText(estimate) : undefined;
  return text ? <span className="op-eta">{text}</span> : null;
}

export function OperationEtaByKey({ taskKey }: { taskKey: string }) {
  const task = useOperation(taskKey);
  return <OperationEta estimate={task?.state === "running" ? task.estimate : undefined} />;
}

export function OperationEtaById({ id }: { id: number }) {
  const task = useOperationById(id);
  return <OperationEta estimate={task?.state === "running" ? task.estimate : undefined} />;
}
