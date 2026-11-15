import { useEffect, useState } from "react";
import { useAppHidden } from "../lib/appVisibility";

/** O(1), once per visible running second, with no IPC or work while hidden. */
export function useTaskElapsed(active: boolean, startedAt?: number, operationKey?: unknown): number {
  const hidden = useAppHidden();
  const [run, setRun] = useState(() => ({ active, key: operationKey, since: Date.now() }));
  const [now, setNow] = useState(Date.now);
  if (run.active !== active || !Object.is(run.key, operationKey)) {
    setRun({ active, key: operationKey, since: Date.now() });
  }
  useEffect(() => {
    if (!active || hidden) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, hidden, startedAt, operationKey]);
  return active ? Math.max(0, Math.floor((now - (startedAt ?? run.since)) / 1000)) : 0;
}
