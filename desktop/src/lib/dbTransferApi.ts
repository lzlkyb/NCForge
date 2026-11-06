import { invoke } from "./tauri";
import type { BoundCell, ExportFileOut } from "./dbApi";
import type { TransferData, TransferFormat, TransferOptions } from "./resultTransfer";

export interface TransferDestination { token: string; path: string }
export interface TransferFileOut extends ExportFileOut { warnings: string[]; destinationToken: string }
export interface TransferSheet { name: string; data: TransferData }
export interface TransferFileReq {
  id: string; sql: string; format: TransferFormat; fileName: string; exportId: number;
  maxRows?: number; timeoutSec?: number; destinationToken?: string;
  options: TransferOptions; data?: TransferData; sheets?: TransferSheet[];
  expectedColumns?: string[]; params?: BoundCell[];
  context?: { source: string; scope: string }; text?: string; textRows?: number;
  textTruncated?: boolean; textWarnings?: string[];
}
export interface TransferProgress {
  id: string; exportId: number; rows: number; bytes: number; elapsedMs: number;
  rowsPerSec: number; bytesPerSec: number; totalRows?: number;
  phase: "preparing" | "writing" | "finalizing";
  processedBytes?: number; bytesKind?: "buffered" | "file";
}
export const dbTransferApi = {
  pick: (format: TransferFormat, fileName: string) => invoke<TransferDestination | null>("db_transfer_pick", { format, fileName }),
  file: (req: TransferFileReq) => invoke<TransferFileOut | null>("db_transfer_file", { req }),
  open: (token: string, reveal = false) => invoke<void>("db_transfer_open", { token, reveal }),
};
