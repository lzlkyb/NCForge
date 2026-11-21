import { getDb } from "./dbStore";
import { ddlCacheMetrics } from "./ddlCache";
import { monaco } from "./monacoSetup";

export function storageMetrics() {
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  const models = monaco.editor.getModels();
  let modelTextBytes = 0;
  for (const model of models) modelTextBytes += model.getValueLength() * 2;
  let resultSets = 0, resultRows = 0, pinned = 0;
  for (const tab of getDb().tabs) {
    if (tab.kind !== "sql") continue;
    for (const result of tab.results) {
      if (result.kind !== "rows") continue;
      if (result.pinned) pinned++;
      resultSets += result.sets?.length || 1;
      resultRows += result.sets?.length ? result.sets.reduce((sum, set) => sum + set.rows.length, 0) : result.rows.length;
    }
  }
  return { heap, models: models.length, modelTextBytes, resultSets, resultRows, pinned, ddl: ddlCacheMetrics() };
}
