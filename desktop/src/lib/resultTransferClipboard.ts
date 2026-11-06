import { serializeTransfer, validateTransfer, type TransferData, type TransferOptions } from "./resultTransfer";
import { beginOperation } from "./operations";
import { dbTaskSpec } from "./dbOperations";
import { toast } from "../components/ui/toast";
import type { TransferSource } from "./resultTransferContext";

const MAX_CLIPBOARD_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();
export function estimateTransferBytes(data: TransferData, options: TransferOptions): number {
  const indices = options.columnIndices.length ? options.columnIndices : data.columns.map((_, i) => i);
  let bytes = 0;
  // Bound the estimate too: scanning a giant selection must not freeze the UI before its warning.
  for (const row of data.rows) {
    for (const i of indices) { bytes += encoder.encode(String(row[i] ?? "")).length + 24; if (bytes > MAX_CLIPBOARD_BYTES) return bytes; }
    bytes += 8;
  }
  return bytes;
}
export async function serializeTransferAsync(data: TransferData, options: TransferOptions): Promise<string> {
  if (data.rows.length * options.columnIndices.length < 2000 || typeof Worker === "undefined") {
    await new Promise(resolve => setTimeout(resolve, 0));
    return serializeTransfer(data, options);
  }
  const worker = new Worker(new URL("./resultTransferWorker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<string>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ text?: string; error?: string }>) => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.text ?? "");
      worker.onerror = () => reject(new Error("生成复制内容失败，请改用文件导出"));
      worker.postMessage({ data, options });
    });
  } finally { worker.terminate(); }
}
export async function copyTransfer(data: TransferData, options: TransferOptions, source: TransferSource, raw = false): Promise<boolean> {
  const error = validateTransfer(data, options);
  if (error) { toast(error, "warning"); return false; }
  if (!data.rows.length && options.header === "none") { toast("没有可复制的数据，可先调整筛选", "info"); return false; }
  if (estimateTransferBytes(data, options) > MAX_CLIPBOARD_BYTES) { toast("复制内容超过 5 MiB，请使用文件导出", "warning"); return false; }
  const task = beginOperation(dbTaskSpec(`copy:${source.resultId}`, "生成复制内容", source.connId, "查询结果", undefined, source.tabId));
  if (!task) return false;
  try {
    const text = raw ? String(data.rows[0]?.[options.columnIndices[0]] ?? "") : await serializeTransferAsync(data, { ...options, bom: false });
    if (encoder.encode(text).length > MAX_CLIPBOARD_BYTES) throw new Error("复制内容超过 5 MiB，请使用文件导出");
    if (options.format === "html" && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([text], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    } else await navigator.clipboard.writeText(text);
    const columns = options.columnIndices.length || data.columns.length;
    toast(`已复制 ${data.rows.length} 行 × ${columns} 列 · ${raw ? "原始值" : options.format.toUpperCase()}`, "success");
    task.finish("success", `已复制 ${data.rows.length} 行 × ${columns} 列`);
    return true;
  } catch (error) {
    task.finish("failed", "复制失败，返回结果页保存为文件");
    toast(error instanceof Error ? error.message : `复制失败：${String(error)}，可改用文件导出`, "error");
    return false;
  }
}
