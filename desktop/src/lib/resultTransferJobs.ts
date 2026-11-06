import { useCallback, useSyncExternalStore } from "react";
import { dbApi } from "./dbApi";
import { dbTransferApi, type TransferFileReq, type TransferFileOut, type TransferProgress } from "./dbTransferApi";
import { beginOperation, cancelOperation } from "./operations";
import { dbTaskSpec } from "./dbOperations";
import { listen } from "./tauri";
import { friendlyDbError } from "./db";
import { toast } from "../components/ui/toast";
import type { TransferSource, TransferRetry } from "./resultTransferContext";

export interface TransferJob {
  state: "running" | "cancelling" | "success" | "partial" | "failed" | "cancelled";
  operationId: number; exportId: number; startedAt: number; summary: string;
  progress: TransferProgress; out?: TransferFileOut; error?: string;
  notice?: string;
  retry?:TransferRetry;
}
const jobs = new Map<string, TransferJob>();
const listeners = new Set<() => void>();
let sequence = 0;
export const transferJobKey = (source: TransferSource) => `${source.connId ?? "local"}:${source.resultId}`;
export const getTransferJob = (key: string) => jobs.get(key) ?? null;
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
function set(key: string, job: TransferJob) { jobs.set(key, job); listeners.forEach(f => f()); }
export function useTransferJob(key: string) {
  const snapshot = useCallback(() => getTransferJob(key), [key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function clearTransferJob(key: string) {
  const job = jobs.get(key);
  if (job && ["running", "cancelling"].includes(job.state)) return;
  jobs.delete(key); listeners.forEach(f => f());
}
export async function stopTransferJob(key: string): Promise<void> {
  const job = jobs.get(key);
  if (!job || job.state !== "running") return;
  set(key, { ...job, state: "cancelling", notice:undefined });
  await cancelOperation(job.operationId);
}
export async function startTransferJob(source: TransferSource, request: Omit<TransferFileReq, "exportId">, summary: string, retry?:TransferRetry): Promise<void> {
  const key = transferJobKey(source);
  if (["running", "cancelling"].includes(jobs.get(key)?.state ?? "")) return;
  sequence = Math.max(sequence + 1, Date.now() * 1024);
  const exportId = sequence;
  let registered = false;
  const task = beginOperation({ ...dbTaskSpec(`transfer:${key}`, "导出查询结果", source.connId, "结果文件导出", undefined, source.tabId),
    phase: "准备导出", cancel: async () => {
      if (!registered) { const current = jobs.get(key); if (current) set(key, { ...current, state: "running", notice:"导出尚在准备，请稍后停止" }); toast("导出尚在准备，请稍后停止", "info"); throw new Error("导出尚在准备，请稍后停止"); }
      try { await dbApi.cancelExport(exportId); }
      catch (error) { const current = jobs.get(key); if (current?.exportId !== exportId || !["running","cancelling"].includes(current.state)) return; set(key, { ...current, state: "running", notice:`停止请求失败：${friendlyDbError(error)}，可重试` }); toast(`停止请求失败：${friendlyDbError(error)}，可重试`, "error"); throw error; }
    },
  });
  if (!task) return;
  const progress: TransferProgress = { id: source.connId ?? "", exportId, rows: 0, bytes: 0, elapsedMs: 0,
    rowsPerSec: 0, bytesPerSec: 0, phase: "preparing", totalRows: request.data?.rows.length };
  set(key, { state: "running", operationId: task.id, exportId, startedAt: Date.now(), summary, progress, retry });
  let un: (() => void) | undefined;
  try {
    un = await listen<TransferProgress>("db:export-progress", p => {
      if (p.exportId !== exportId || p.id !== (source.connId ?? "")) return;
      registered = true;
      const current = jobs.get(key); if (!current || current.exportId !== exportId) return;
      set(key, { ...current, progress: p });
      task.update({ phase: p.phase === "finalizing" ? "完成文件" : p.phase === "preparing" ? "准备查询" : "读取并写入文件", progress: { done: p.rows, total: p.totalRows } });
    });
    const out = await dbTransferApi.file({ ...request, exportId });
    const current = jobs.get(key)!;
    if (!out) { set(key, { ...current, state: "cancelled" }); task.finish("cancelled", "未保存文件"); return; }
    const partial = out.canceled || out.truncated;
    set(key, { ...current, state: partial ? "partial" : "success", out });
    task.finish(out.canceled ? "cancelled" : "success", `已写 ${out.rows} 行${partial ? "，部分结果" : "，文件已保存"}`);
    toast(`已${partial ? "保存部分结果" : "导出"} ${out.rows} 行 · ${out.fileName}`, partial || out.warnings.length ? "warning" : "success");
  } catch (error) {
    const current = jobs.get(key)!;
    set(key, { ...current, state: "failed", error: friendlyDbError(error) });
    task.finish("failed", "导出失败，返回结果页查看原因");
    toast(`导出失败：${friendlyDbError(error)}`, "error");
  } finally {
    un?.();
    const latest=jobs.get(key);if(latest){jobs.delete(key);jobs.set(key,latest);}
    const completed = [...jobs].filter(([, j]) => !["running", "cancelling"].includes(j.state));
    // Keep recent retry snapshots bounded; long-term history needs only file/status metadata.
    for(const [k,j] of completed.slice(0,-5)) if(j.retry) jobs.set(k,{...j,retry:undefined});
    completed.slice(0, Math.max(0, completed.length - 30)).forEach(([k]) => jobs.delete(k));
    listeners.forEach(f=>f());
  }
}
