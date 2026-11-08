import type { TransferData, TransferOptions } from "./resultTransfer";
export const MAX_CLIPBOARD_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();
function cellBytes(value: unknown): number {
  const text = String(value ?? "");
  // UTF-8 is never smaller than the number of UTF-16 code units for valid text.
  if (text.length > MAX_CLIPBOARD_BYTES) return text.length;
  return encoder.encode(text).length + 24;
}
export function estimateTransferBytes(data: TransferData, options: TransferOptions): number {
  const indices = options.columnIndices.length ? options.columnIndices : data.columns.map((_, i) => i);
  let bytes = 0;
  for (const row of data.rows) {
    for (const i of indices) { bytes += cellBytes(row[i]); if (bytes > MAX_CLIPBOARD_BYTES) return bytes; }
    bytes += 8;
  }
  return bytes;
}
export async function estimateTransferBytesAsync(data: TransferData, options: TransferOptions): Promise<number> {
  const indices = options.columnIndices.length ? options.columnIndices : data.columns.map((_, i) => i);
  let bytes = 0, started = performance.now();
  for (const row of data.rows) {
    for (const i of indices) {
      bytes += cellBytes(row[i]); if (bytes > MAX_CLIPBOARD_BYTES) return bytes;
      if (performance.now() - started >= 6) { await new Promise(resolve => setTimeout(resolve, 0)); started = performance.now(); }
    }
    bytes += 8;
  }
  return bytes;
}
