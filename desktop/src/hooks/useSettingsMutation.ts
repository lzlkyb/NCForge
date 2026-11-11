import { useEffect, useRef, useState } from "react";
import { failureText } from "../lib/friendlyError";

type Feedback = { pending: boolean; saved?: boolean; error?: string };

/** Serialize related writes; a later response must never roll back a newer choice. */
export function useSettingsMutation() {
  const [state, setState] = useState<Record<string, Feedback>>({});
  const queue = useRef(Promise.resolve());
  const jobs = useRef(new Map<string, () => Promise<void>>());
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (key: string, job: () => Promise<void>) => {
    if (pending.current.has(key)) return false;
    jobs.current.set(key, job);
    pending.current.add(key);
    setState(prev => ({ ...prev, [key]: { pending: true } }));
    let ok = false;
    const next = queue.current.then(async () => {
      try {
        await job();
        ok = true;
        if (mounted.current) setState(prev => ({ ...prev, [key]: { pending: false, saved: true } }));
      } catch (e) {
        if (mounted.current) setState(prev => ({ ...prev, [key]: { pending: false, error: failureText("保存设置", e) } }));
      } finally { pending.current.delete(key); }
    });
    queue.current = next;
    await next;
    return ok;
  };
  const feedback = (key: string) => ({ ...state[key], onRetry: () => { const job = jobs.current.get(key); if (job) void run(key, job); } });
  return { run, feedback };
}
