import { useEffect, useState } from "react";
import { useAppHidden } from "../lib/appVisibility";
import { WAIT_FEEDBACK } from "../lib/motion";

/** Only delay the visual indicator; callers lock/start their operation immediately. */
export function useDelayedBusy(active: boolean, operationKey?: unknown): boolean {
  const hidden = useAppHidden();
  const [run, setRun] = useState(() => ({ active, key: operationKey, since: Date.now(), visible: false }));
  if (run.active !== active || !Object.is(run.key, operationKey)) {
    setRun({ active, key: operationKey, since: Date.now(), visible: false });
  }
  useEffect(() => {
    if (!active || hidden || run.visible) return;
    const reveal = () => setRun(current => current.active && Object.is(current.key, operationKey)
      ? { ...current, visible: true } : current);
    const remaining = WAIT_FEEDBACK.reveal - (Date.now() - run.since);
    if (remaining <= 0) { reveal(); return; }
    const timer = window.setTimeout(reveal, remaining);
    return () => window.clearTimeout(timer);
  }, [active, hidden, operationKey, run.since, run.visible]);
  return active && run.active && Object.is(run.key, operationKey) && run.visible;
}
