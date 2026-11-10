import { useSyncExternalStore } from "react";

/**
 * 「未写回改动」登记表。
 *
 * 表页 / 结果网格的改动都在组件本地 state 里，切子页、切文档、切结果标签、关标签
 * 会直接卸载组件，改动就静默没了。这里只记「哪个标签、哪个结果还有几处没写回」，
 * 让标签条、关闭流程、切换流程能统一问一句 / 画一个小圆点。
 *
 * 只存计数，不存改动本身：真正的改动仍在组件里，避免两处状态互相漂移。
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();
let revision = 0;

const notify = () => { revision++; listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };

export const tableEditKey = (tabId: string) => `table:${tabId}`;
export const resultEditKey = (tabId: string, resultId: string) => `result:${tabId}:${resultId}`;

export function reportEditCount(key: string, count: number) {
  const next = Math.max(0, Math.trunc(count));
  const cur = counts.get(key) ?? 0;
  if (cur === next) return;
  if (next === 0) counts.delete(key); else counts.set(key, next);
  notify();
}

export function pendingEdits(key: string) {
  return counts.get(key) ?? 0;
}

export function clearEdits(key: string) {
  if (!counts.delete(key)) return;
  notify();
}

/** 这个标签下（表页 + 所有结果标签）还有多少处未写回改动。 */
export function pendingForTab(tabId: string) {
  let total = pendingEdits(tableEditKey(tabId));
  const prefix = `result:${tabId}:`;
  for (const [key, n] of counts) if (key.startsWith(prefix)) total += n;
  return total;
}

export function clearEditsForTab(tabId: string) {
  let changed = false;
  if (counts.delete(tableEditKey(tabId))) changed = true;
  const prefix = `result:${tabId}:`;
  for (const key of [...counts.keys()]) if (key.startsWith(prefix) && counts.delete(key)) changed = true;
  if (changed) notify();
}

/** 让标签条跟着登记表重渲染；计数直接用 `pendingEdits` / `pendingForTab` 读。 */
export function useEditRevision() {
  return useSyncExternalStore(subscribe, () => revision, () => 0);
}

export function __resetEditsForTest() {
  counts.clear();
  notify();
}
