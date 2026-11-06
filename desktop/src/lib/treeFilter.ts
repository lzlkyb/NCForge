import { useCallback } from "react";
import { createSessionStore, useSessionStore, type SessionStore } from "./sessionStore";

interface TreeFilter { text: string; open: boolean }
const filters = new Map<string, SessionStore<TreeFilter>>();
export function treeFilterFor(root: string) {
  const key = root.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  let store = filters.get(key);
  if (!store) {
    store = createSessionStore<TreeFilter>({ text: "", open: false });
    filters.set(key, store);
    // 展示过滤不属于工程配置；限制会话缓存，不随访问的工程数量无限增长。
    if (filters.size > 16) filters.delete(filters.keys().next().value!);
  }
  return store;
}
export const useTreeFilter = (root: string) => useSessionStore(treeFilterFor(root));
export function useTreeFilterState(root: string) {
  const store = treeFilterFor(root), state = useSessionStore(store);
  const setText = useCallback((value: string | ((previous: string) => string)) => {
    const text = typeof value === "function" ? value(store.get().text) : value;
    store.set({ text, ...(text ? { open: true } : {}) });
  }, [store]);
  return [state.text, setText] as const;
}
