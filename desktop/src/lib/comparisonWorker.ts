import { buildComparison } from "./comparisonModel";
import type { ResultSnapshot } from "./dbResultTools";
let before: ResultSnapshot, after: ResultSnapshot;
self.onmessage = (event: MessageEvent<{ kind: "init" | "rows" | "run"; before: ResultSnapshot; after: ResultSnapshot; side: "before" | "after"; rows: ResultSnapshot["rows"]; keys: string[] }>) => {
  const data = event.data;
  try {
    if (data.kind === "init") { before = data.before; after = data.after; }
    else if (data.kind === "rows") (data.side === "before" ? before : after).rows.push(...data.rows);
    else self.postMessage({ model: buildComparison(before, after, data.keys), error: "" });
  } catch (error) { self.postMessage({ model: null, error: String(error) }); }
};
