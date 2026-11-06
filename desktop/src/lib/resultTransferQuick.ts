import { defaultTransferOptions, type TransferFormat } from "./resultTransfer";
import { copyTransfer } from "./resultTransferClipboard";
import { scopedTransferData, selectionIndices, type TransferFrame } from "./resultTransferContext";

export async function quickCopyTransfer(frame: TransferFrame, format: TransferFormat = "tsv", raw = false): Promise<boolean> {
  const options = defaultTransferOptions(format);
  options.columnIndices = [...selectionIndices(frame)]; options.columnLabels = frame.labels;
  if (!options.columnIndices.length) return false;
  options.table = frame.source.table === "表名" ? "" : frame.source.table ?? "";
  options.header = frame.selection ? "none" : "name";
  if (format === "where") options.keys = [options.columnIndices[0]];
  const data = scopedTransferData(frame, frame.selection ? "selection" : "filtered", true);
  return copyTransfer(data, options, frame.source, raw || (format === "tsv" && !!frame.selection && data.rows.length === 1 && options.columnIndices.length === 1));
}
