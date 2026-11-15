import { useSyncExternalStore } from "react";

let path: string | null = null;
const listeners = new Set<() => void>();
const key = (value: string) => value.replace(/\\/g, "/").toLowerCase();
export const getHistoryRestorePath = () => path;
export const isHistoryRestoring = (value: string) => !!path && key(path) === key(value);
export function beginHistoryRestore(value: string): boolean {
  if (path) return false;
  path = value; listeners.forEach(fn => fn()); return true;
}
export function endHistoryRestore(): void { path = null; listeners.forEach(fn => fn()); }
export function useHistoryRestorePath() {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, getHistoryRestorePath, getHistoryRestorePath);
}
