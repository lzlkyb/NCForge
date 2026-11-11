import type { SqlTab } from "./dbStore";

export const pendingResultId = (batchId: number, index: number) => `pending:${batchId}:${index}`;
export function pendingResults(tab: Pick<SqlTab, "batch">) {
  const batch = tab.batch;
  return batch?.statements.filter(s => s.index > batch.completed).map(s => ({
    ...s, id: pendingResultId(batch.id, s.index),
    state: batch.status !== "running" ? "skipped" : batch.activeIndex === s.index ? "running" : "waiting",
  })) ?? [];
}
export function resultPairOf(ids: string[], requested?: [string, string], selected?: string | null): string[] {
  const first = requested && ids.includes(requested[0]) ? requested[0] : selected && ids.includes(selected) ? selected : ids[0];
  const second = requested && ids.includes(requested[1]) && requested[1] !== first ? requested[1] : ids.find(id => id !== first);
  return [first, second].filter((id): id is string => !!id);
}
