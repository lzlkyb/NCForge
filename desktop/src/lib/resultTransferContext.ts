import type { Cell, BoundCell } from "./dbApi";
import type { Selection } from "./dbResultTools";
import { selectedRows, selectedCols } from "./dbResultTools";
import type { TransferData, TransferOptions } from "./resultTransfer";
import type { TransferSheet, TransferDestination } from "./dbTransferApi";
import { splitStatements, isWrite } from "./sqlSplit";

export type TransferScope = "selection" | "filtered" | "loaded" | "query";
export interface TransferSource {
  connId: string | null; resultId: string; tabId?: string; sql: string; source: string;
  complete: boolean; canRequery?: boolean; params?: BoundCell[]; timeoutSec?: number; table?: string;
  keys?: string[]; sheets?: TransferSheet[];
}
export interface TransferFrame {
  data: TransferData; order: number[]; visible: number[]; selection: Selection | null;
  labels: string[]; source: TransferSource;
}
export interface TransferDialogSeed {
  options:TransferOptions; scope:TransferScope; edited:boolean; columnOrder:number[];
  allSets?:boolean; fileName?:string; destination?:TransferDestination|null;
}
export interface TransferRetry { frame:TransferFrame; seed:TransferDialogSeed }
export const transferScopeLabel: Record<TransferScope, string> = {
  selection: "当前选区", filtered: "当前筛选结果", loaded: "已加载全部行", query: "重新查询导出全部",
};
export function selectionIndices(frame: TransferFrame): number[] {
  return frame.selection ? selectedCols(frame.visible, frame.selection) : frame.visible;
}
export function scopeIndices(frame: TransferFrame, scope: TransferScope): number[] {
  if (scope === "selection") return frame.selection ? selectedRows(frame.order, frame.selection) : frame.order;
  return scope === "filtered" ? frame.order : frame.data.rows.map((_, i) => i);
}
export function scopedTransferData(frame: TransferFrame, scope: TransferScope, edited: boolean): TransferData {
  const indices = scopeIndices(frame, scope);
  const original = frame.data.originalRows ?? frame.data.rows;
  return { columns: frame.data.columns, query: frame.source.sql,
    rows: indices.map(i => (edited && scope !== "query" ? frame.data.rows : original)[i]),
    originalRows: indices.map(i => original[i]),
  };
}
export function transferCanRequery(source: TransferSource): boolean {
  if (!source.connId || source.canRequery === false || !source.sql.trim()) return false;
  const statements = splitStatements(source.sql);
  return statements.length === 1 && !isWrite(statements[0].text) && /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:select|with)\b/i.test(source.sql);
}
/** Freeze before opening: later paging, editing or connection changes must not redirect an export. */
export function freezeTransferFrame(frame: TransferFrame, value: (r: number, c: number) => Cell): TransferFrame {
  return { ...frame, order: [...frame.order], visible: [...frame.visible], labels: [...frame.labels],
    selection: frame.selection ? { anchor: { ...frame.selection.anchor }, end: { ...frame.selection.end } } : null,
    source: { ...frame.source, keys: frame.source.keys ? [...frame.source.keys] : undefined, params: frame.source.params?.map(p => typeof p === "object" && p ? { ...p } : p),
      sheets: frame.source.sheets?.map(s => ({ name: s.name, data: { ...s.data, columns: s.data.columns.map(c => ({ ...c })), rows: s.data.rows.map(r => [...r]), originalRows: s.data.originalRows?.map(r => [...r]) } })) },
    data: { columns: frame.data.columns.map(c => ({ ...c })), query: frame.source.sql,
      originalRows: (frame.data.originalRows ?? frame.data.rows).map(r => [...r]),
      rows: frame.data.rows.map((r, i) => r.map((_, c) => value(i, c))),
    },
  };
}
