import type { ResultFileGroup, ResultHit } from "./searchResults";

export const resultHitKey = (group: ResultFileGroup, hit: ResultHit) => JSON.stringify([group.key, hit.line]);
export function searchEntries(groups: ResultFileGroup[]) {
  return groups.flatMap(group => group.hits.map(hit => ({ group, hit, key: resultHitKey(group, hit) })));
}
export function nextSearchEntry(entries: ReturnType<typeof searchEntries>, key: string | null, direction: -1 | 1) {
  if (!entries.length) return null;
  const current = entries.findIndex(entry => entry.key === key);
  const index = current < 0 ? direction === 1 ? 0 : entries.length - 1 : Math.max(0, Math.min(entries.length - 1, current + direction));
  return entries[index];
}
