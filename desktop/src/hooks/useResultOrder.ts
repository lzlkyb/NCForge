import { useEffect, useMemo, useState } from "react";
import type { Cell, ColumnMeta } from "../lib/dbApi";
import { viewOrder, type SortState } from "../lib/resultView";

/** Each request owns its worker: cancellation also stops obsolete CPU work. */
export function useResultOrder(rows: Cell[][], columns: ColumnMeta[], filter: string, sort: SortState | null) {
  const heavy = rows.length * columns.length >= 20_000 && (!!filter.trim() || !!sort);
  const fallback = useMemo(() => heavy ? [] : viewOrder(rows, columns, filter, sort), [rows, columns, filter, sort, heavy]);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ rows: Cell[][]; columns: ColumnMeta[]; filter: string; sort: SortState | null; order: number[]; error?: string } | null>(null);
  useEffect(() => {
    if (!heavy) return;
    let active = true, worker: Worker | undefined;
    const timer = setTimeout(() => {
      const fail = () => { worker?.terminate(); if (active) setResult({ rows, columns, filter, sort, order: [], error: "结果计算失败，请重试或清除筛选与排序。" }); active = false; };
      try {
        worker = new Worker(new URL("../lib/resultOrderWorker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ order?: number[]; error?: string }>) => {
          if (!active) return;
          if (event.data.error) fail();
          else setResult({ rows, columns, filter, sort, order: event.data.order ?? [] });
          active = false;
          worker?.terminate();
        };
        worker.onerror = fail;
        worker.postMessage({ kind: "init", columns, filter, sort });
        // One giant structured clone would still freeze the UI before the worker starts.
        void (async () => {
          for (let i = 0; i < rows.length && active; i += 128) {
            worker!.postMessage({ kind: "rows", rows: rows.slice(i, i + 128) });
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          if (active) worker!.postMessage({ kind: "run" });
        })().catch(fail);
      } catch { fail(); }
    }, 120);
    return () => { active = false; clearTimeout(timer); worker?.terminate(); };
  }, [rows, columns, filter, sort, heavy, retry]);
  const current = result?.rows === rows && result.columns === columns && result.filter === filter && result.sort === sort ? result : null;
  return { order: heavy ? current?.order ?? [] : fallback, pending: heavy && !current, error: heavy ? current?.error : undefined,
    retry: () => { setResult(null); setRetry(v => v + 1); } };
}
