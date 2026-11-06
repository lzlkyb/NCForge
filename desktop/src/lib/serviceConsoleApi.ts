import { listen } from "@tauri-apps/api/event";
import { invoke } from "./tauri";
import { beginOperation } from "./operations";

export type ServiceLogTarget = "middleware" | "client";
export interface ServiceLogPage {
  text: string; startOffset: number; offset: number; fileId: string; size: number;
  eof: boolean; reset: boolean; truncated: boolean; lineOffsets: number[];
}
export interface ServiceLogExportResult { path: string; bytes: number; canceled: boolean; ms: number }
export const serviceLogRead = (target: ServiceLogTarget, previous: boolean, offset: number, fileId?: string) =>
  invoke<ServiceLogPage>("service_log_read", { target, previous, offset, fileId: fileId ?? null });
export const serviceLogTail = (target: ServiceLogTarget, previous: boolean, before?: number, fileId?: string) =>
  invoke<ServiceLogPage>("service_log_tail", { target, previous, before: before ?? null, fileId: fileId ?? null });
export const serviceLogClear = (target: ServiceLogTarget) =>
  invoke<{ offset: number; rotated: false }>("service_log_clear", { target });

/** Picker grants only the selected destination; streaming export never loads the entire file into JS. */
export async function serviceLogExport(target: ServiceLogTarget, previous: boolean, fileId?: string, signal?: AbortSignal): Promise<ServiceLogExportResult | null> {
  return exportLog(target, previous, fileId, signal);
}
export async function serviceLogExportText(target: ServiceLogTarget, previous: boolean, text: string, signal?: AbortSignal): Promise<ServiceLogExportResult | null> {
  return exportLog(target, previous, undefined, signal, text);
}
async function exportLog(target: ServiceLogTarget, previous: boolean, fileId?: string, signal?: AbortSignal, text?: string): Promise<ServiceLogExportResult | null> {
  if (signal?.aborted) return null;
  const jobId = crypto.randomUUID();
  let aborted = false;
  const cancel = async () => { aborted = true; await invoke<void>("service_log_cancel_export", { jobId }); };
  const task = beginOperation({ key: `service.log.export:${target}:${previous}:${text === undefined ? 'file' : 'loaded'}`, label: text === undefined ? "导出完整控制台日志" : "导出已加载匹配日志", scope: target === "client" ? "客户端" : "中间件", page: "files", panel: "svc", phase: "选择保存位置", cancel });
  if (!task) throw new Error("这份日志正在导出，请等待完成或取消");
  let unlisten: (() => void) | undefined;
  const onAbort = () => { void cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    unlisten = await listen<{ jobId: string; bytes: number; totalBytes: number }>("service:log-export", ({ payload }) => {
      if (payload.jobId === jobId) task.update({ phase: "正在写入日志快照", progress: { done: payload.bytes, total: payload.totalBytes } });
    });
    if (signal?.aborted || aborted) { task.finish("cancelled", "日志导出已取消"); return null; }
    const result = await invoke<ServiceLogExportResult | null>("service_log_export", { target, previous, fileId: fileId ?? null, jobId, text: text ?? null });
    task.finish(result ? "success" : "cancelled", result ? `已保存 ${result.bytes} 字节日志快照` : "日志导出已取消，现有文件保留");
    return result;
  } catch (error) {
    task.finish(aborted ? "cancelled" : "failed", String(error instanceof Error ? error.message : error));
    throw error;
  } finally { unlisten?.(); signal?.removeEventListener("abort", onAbort); }
}
