import { viewOrder, type SortState } from "./resultView";
import type { Cell, ColumnMeta } from "./dbApi";
let rows: Cell[][] = [], columns: ColumnMeta[], filter: string, sort: SortState | null;
self.onmessage = (event: MessageEvent<{ kind: "init" | "rows" | "run"; rows: Cell[][]; columns: ColumnMeta[]; filter: string; sort: SortState | null }>) => {
  try {
    const message = event.data;
    if (message.kind === "init") { rows = []; columns = message.columns; filter = message.filter; sort = message.sort; }
    else if (message.kind === "rows") rows.push(...message.rows);
    else { filter = message.filter; sort = message.sort; self.postMessage({ order: viewOrder(rows, columns, filter, sort) }); }
  } catch (error) { self.postMessage({ error: String(error) }); }
};
