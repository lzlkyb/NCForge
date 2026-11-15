import { defaultTransferOptions, type TransferFormat } from "./resultTransfer";
import { copyTransfer } from "./resultTransferClipboard";
import { scopeIndices, selectionIndices, type TransferFrame } from "./resultTransferContext";
import type { Cell } from "./dbApi";

export async function quickCopyTransfer(frame: TransferFrame, format: TransferFormat = "tsv", raw = false, edits?: ReadonlyMap<string, Cell>): Promise<boolean> {
  const options = defaultTransferOptions(format);
  options.columnIndices = [...selectionIndices(frame)]; options.columnLabels = frame.labels;
  if (!options.columnIndices.length) return false;
  options.table = frame.source.table === "表名" ? "" : frame.source.table ?? "";
  options.header = frame.selection ? "none" : "name";
  if (format === "where") options.keys = [options.columnIndices[0]];
  const indices = scopeIndices(frame, frame.selection ? "selection" : "filtered");
  const rows = indices.map(r => frame.data.rows[r]);
  if (edits?.size) {
    const positions = new Map(indices.map((r, i) => [r, i]));
    for (const [key, value] of edits) {
      const separator = key.indexOf(":");
      const r = Number(key.slice(0, separator)), c = Number(key.slice(separator + 1));
      const i = positions.get(r);
      if (i === undefined || c < 0 || c >= rows[i].length) continue;
      if (rows[i] === frame.data.rows[r]) rows[i] = [...rows[i]];
      rows[i][c] = value;
    }
  }
  const original = frame.data.originalRows ?? frame.data.rows;
  const data = { columns: frame.data.columns, rows, query: frame.source.sql,
    originalRows: frame.data.originalRows || format === "update" ? indices.map(r => original[r]) : undefined };
  return copyTransfer(data, options, frame.source, raw || (format === "tsv" && !!frame.selection && data.rows.length === 1 && options.columnIndices.length === 1));
}
