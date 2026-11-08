import { useEffect, useMemo, useRef, useState } from "react";
import type { Cell, ColumnMeta } from "../lib/dbApi";
import { viewOrder, type SortState } from "../lib/resultView";

type CachedWorker = { worker: Worker; rows: Cell[][]; columns: ColumnMeta[]; idle: boolean; expiry?: ReturnType<typeof setTimeout> };
function release(cached: CachedWorker | null) { if (cached) { clearTimeout(cached.expiry); cached.worker.terminate(); } }
/** Busy work remains cancellable; completed data is reused briefly for consecutive filters. */
export function useResultOrder(rows: Cell[][], columns: ColumnMeta[], filter: string, sort: SortState | null) {
  const heavy = rows.length * columns.length >= 20_000 && (!!filter.trim() || !!sort);
  const fallback = useMemo(() => heavy ? [] : viewOrder(rows, columns, filter, sort), [rows, columns, filter, sort, heavy]);
  const [retry, setRetry] = useState(0);
  const retained = useRef<CachedWorker | null>(null);
  useEffect(() => () => { release(retained.current); retained.current = null; }, []);
  const [result, setResult] = useState<{ rows: Cell[][]; columns: ColumnMeta[]; filter: string; sort: SortState | null; order: number[]; error?: string } | null>(null);
  useEffect(() => {
    if (!heavy) { release(retained.current); retained.current = null; return; }
    let active = true, worker: Worker | undefined;
    const timer = setTimeout(() => {
      const fail = () => { if (retained.current?.worker === worker) { release(retained.current); retained.current = null; } if (active) setResult({ rows, columns, filter, sort, order: [], error: "结果计算失败，请重试或清除筛选与排序。" }); active = false; };
      try {
        const cached = retained.current;
        const reuse = cached?.idle && cached.rows === rows && cached.columns === columns;
        if (reuse) { clearTimeout(cached.expiry); cached.idle = false; worker = cached.worker; }
        else {
          release(cached);
          retained.current = null;
          worker = new Worker(new URL("../lib/resultOrderWorker.ts", import.meta.url), { type: "module" });
          retained.current = { worker, rows, columns, idle: false };
        }
        worker.onmessage = (event: MessageEvent<{ order?: number[]; error?: string }>) => {
          if (!active) return;
          if (event.data.error) { fail(); return; }
          setResult({ rows, columns, filter, sort, order: event.data.order ?? [] });
          active = false;
          const completed = retained.current!;
          completed.idle = true;
          // Avoid retaining a second copy of a large result indefinitely in an inactive tab.
          completed.expiry = setTimeout(() => { if (retained.current === completed) { release(completed); retained.current = null; } }, 5000);
        };
        worker.onerror = fail;
        if (reuse) { worker.postMessage({ kind: "run", filter, sort }); return; }
        worker.postMessage({ kind: "init", columns, filter, sort });
        // One giant structured clone would still freeze the UI before the worker starts.
        void (async () => {
          for (let i = 0; i < rows.length && active; i += 128) {
            worker!.postMessage({ kind: "rows", rows: rows.slice(i, i + 128) });
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          if (active) worker!.postMessage({ kind: "run", filter, sort });
        })().catch(fail);
      } catch { fail(); }
    }, retained.current?.idle && retained.current.rows === rows && retained.current.columns === columns ? 0 : 120);
    return () => { active = false; clearTimeout(timer); if (!retained.current?.idle) { release(retained.current); retained.current = null; } };
  }, [rows, columns, filter, sort, heavy, retry]);
  const current = result?.rows === rows && result.columns === columns && result.filter === filter && result.sort === sort ? result : null;
  return { order: heavy ? current?.order ?? [] : fallback, pending: heavy && !current, error: heavy ? current?.error : undefined,
    retry: () => { setResult(null); setRetry(v => v + 1); } };
}
