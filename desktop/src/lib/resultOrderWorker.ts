import { viewOrder, type SortState, type ValueFilter } from "./resultView";
import type { Cell, ColumnMeta } from "./dbApi";
let rows: Cell[][] = [], columns: ColumnMeta[], filter: string, sort: SortState | null, value: ValueFilter | null | undefined;
self.onmessage = (event: MessageEvent<{ kind: "init" | "rows" | "run"; rows: Cell[][]; columns: ColumnMeta[]; filter: string; sort: SortState | null; value?: ValueFilter | null }>) => {
  try {
    const message = event.data;
    if (message.kind === "init") { rows = []; columns = message.columns; filter = message.filter; sort = message.sort; value = message.value; }
    else if (message.kind === "rows") rows.push(...message.rows);
    else { filter = message.filter; sort = message.sort; value = message.value; self.postMessage({ order: viewOrder(rows, columns, filter, sort, value) }); }
  } catch (error) { self.postMessage({ error: String(error) }); }
};
