import { useSyncExternalStore } from "react";

/** 侧栏收藏的表：按连接分开，存本机 localStorage。表名统一大写。 */

const KEY = "ncforge-db-fav";
const listeners = new Set<() => void>();

function load(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}

let all = load();

export function toggleFavorite(connId: string, table: string) {
  const t = table.toUpperCase();
  const cur = all[connId] ?? [];
  all = { ...all, [connId]: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t].sort() };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存不下就只在本次生效
  }
  listeners.forEach((fn) => fn());
}

const EMPTY: string[] = [];

export function useFavorites(connId: string): string[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => all[connId] ?? EMPTY,
  );
}
