import { serializeTransfer, validateTransfer, type TransferData, type TransferOptions } from "./resultTransfer";
import { beginOperation } from "./operations";
import { dbTaskSpec } from "./dbOperations";
import { toast } from "../components/ui/toast";
import type { TransferSource } from "./resultTransferContext";
import { estimateTransferBytesAsync, MAX_CLIPBOARD_BYTES } from "./transferSize";
import { isLobPreview } from "./db";
export { estimateTransferBytes } from "./transferSize";

const encoder = new TextEncoder();
export async function serializeTransferAsync(data: TransferData, options: TransferOptions): Promise<string> {
  const indices = options.columnIndices.length ? options.columnIndices : data.columns.map((_, i) => i);
  if (data.rows.length * indices.length < 2000 || typeof Worker === "undefined") {
    await new Promise(resolve => setTimeout(resolve, 0));
    return serializeTransfer(data, options);
  }
  const worker = new Worker(new URL("./resultTransferWorker.ts", import.meta.url), { type: "module" });
  let active = true;
  try {
    return await new Promise<string>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ text?: string; error?: string }>) => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.text ?? "");
      worker.onerror = () => reject(new Error("生成复制内容失败，请改用文件导出"));
      // Only the chosen columns and SQL keys cross the worker boundary. Small messages
      // bound each structured-clone pause; yielding lets the busy indicator paint.
      const needed = new Set([...indices, ...options.keys]);
      const project = (row: TransferData["rows"][number]) => row.map((v, i) => needed.has(i) ? v : null);
      void (async () => {
        worker.postMessage({ kind: "init", data: { ...data, rows: [], originalRows: data.originalRows ? [] : undefined }, options });
        for (let i = 0; i < data.rows.length; i += 128) {
          if (!active) return;
          worker.postMessage({ kind: "rows", rows: data.rows.slice(i, i + 128).map(project), originalRows: data.originalRows?.slice(i, i + 128).map(project) });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (active) worker.postMessage({ kind: "serialize" });
      })().catch(reject);
    });
  } finally { active = false; worker.terminate(); }
}
export async function copyTransfer(data: TransferData, options: TransferOptions, source: TransferSource, raw = false): Promise<boolean> {
  const error = validateTransfer(data, options);
  if (error) { toast(error, "warning"); return false; }
  if (!data.rows.length && options.header === "none") { toast("没有可复制的数据，可先调整筛选", "info"); return false; }
  // 结果集里的 CLOB 只带 8K 预览 + 一段说明。原始值 / IN 条件拿这种串等于拿了一段假数据，
  // 直接拒绝并指路；普通表格复制允许带预览，但要在回执里说明有几格不是全量。
  const columns = options.columnIndices.length ? options.columnIndices : data.columns.map((_, i) => i);
  let previews = 0;
  for (const row of data.rows) for (const c of columns) if (isLobPreview(row[c] ?? null)) { previews++; break; }
  if (previews > 0 && (raw || options.format === "where")) {
    toast(`选中的大文本是 8K 预览，不是完整值；请在单元格详情里点「加载完整值」后再复制`, "warning");
    return false;
  }
  const task = beginOperation(dbTaskSpec(`copy:${source.resultId}`, "生成复制内容", source.connId, "查询结果", undefined, source.tabId));
  if (!task) return false;
  try {
    if (await estimateTransferBytesAsync(data, options) > MAX_CLIPBOARD_BYTES) throw new Error("复制内容超过 5 MiB，请使用文件导出");
    const text = raw ? String(data.rows[0]?.[options.columnIndices[0]] ?? "") : await serializeTransferAsync(data, { ...options, bom: false });
    if (encoder.encode(text).length > MAX_CLIPBOARD_BYTES) throw new Error("复制内容超过 5 MiB，请使用文件导出");
    if (options.format === "html" && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([text], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    } else await navigator.clipboard.writeText(text);
    const count = options.columnIndices.length || data.columns.length;
    const note = previews > 0 ? ` · ${previews} 行含 8K 预览` : "";
    toast(`已复制 ${data.rows.length} 行 × ${count} 列 · ${raw ? "原始值" : options.format.toUpperCase()}${note}`, previews > 0 ? "warning" : "success");
    task.finish("success", `已复制 ${data.rows.length} 行 × ${count} 列`);
    return true;
  } catch (error) {
    task.finish("failed", "复制失败，返回结果页保存为文件");
    toast(error instanceof Error ? error.message : `复制失败：${String(error)}，可改用文件导出`, "error");
    return false;
  }
}
