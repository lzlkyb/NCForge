import { useEffect, useMemo, useState } from "react";
import type { ResultSnapshot } from "../lib/dbResultTools";
import type { ComparisonModel } from "../lib/dbCompareState";
import { buildComparison } from "../lib/comparisonModel";
export function useComparison(before: ResultSnapshot, after: ResultSnapshot, keys: string[]) {
  const heavy = (before.rows.length + after.rows.length) * before.columns.length > 20000;
  const immediate = useMemo(() => {
    if (!keys.length || heavy) return { model: null, error: "" };
    try { return { model: buildComparison(before, after, keys), error: "" }; }
    catch (error) { return { model: null, error: String(error) }; }
  }, [before, after, keys, heavy]);
  const [result, setResult] = useState<{ before: ResultSnapshot; after: ResultSnapshot; keys: string[]; model: ComparisonModel | null; error: string } | null>(null);
  useEffect(() => {
    if (!heavy || !keys.length) return;
    let active = true, worker: Worker | undefined;
    const fail = (error: string) => { if (active) setResult({ before, after, keys, model: null, error }); active = false; worker?.terminate(); };
    try {
      worker = new Worker(new URL("../lib/comparisonWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = event => { if (active) setResult({ before, after, keys, ...event.data }); active = false; worker?.terminate(); };
      worker.onerror = () => fail("比对计算失败，请重新选择比较键后重试");
      worker.postMessage({ kind: "init", before: { ...before, rows: [] }, after: { ...after, rows: [] } });
      // Bound each structured clone so transferring wide inputs does not become a UI long task.
      void (async () => {
        for (const side of ["before", "after"] as const) {
          const rows = side === "before" ? before.rows : after.rows;
          for (let i = 0; i < rows.length && active; i += 64) {
            worker!.postMessage({ kind: "rows", side, rows: rows.slice(i, i + 64) });
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
        if (active) worker!.postMessage({ kind: "run", keys });
      })().catch(error => fail(String(error)));
    } catch (error) { fail(String(error)); }
    // Replacing inputs or closing the document cancels CPU work as well as pending transfers.
    return () => { active = false; worker?.terminate(); };
  }, [before, after, keys, heavy]);
  const current = result?.before === before && result.after === after && result.keys === keys ? result : null;
  return heavy && keys.length ? { model: current?.model ?? null, error: current?.error ?? "", pending: !current } : { ...immediate, pending: false };
}
