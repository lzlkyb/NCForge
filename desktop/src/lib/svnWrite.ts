import { useSyncExternalStore } from "react";

export type SvnWriteKind = "commit" | "update" | "revert" | "resolve";
export interface SvnWriteHandle { root: string; kind: SvnWriteKind; startedAt: number; }
const keyOfRoot = (root: string) => root.replace(/\\/g, "/").toLowerCase();
const writes = new Map<string, SvnWriteHandle>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const getSvnWrite = (root: string | null | undefined): SvnWriteHandle | null => root ? writes.get(keyOfRoot(root)) ?? null : null;
export const useSvnWrite = (root: string | null | undefined) => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => getSvnWrite(root), () => getSvnWrite(root));

/** 在第一个 await 之前锁住整个工作副本，跨页/快捷键也不能另起一次写操作。 */
export function withSvnWriteLock<T>(root: string, kind: SvnWriteKind, work: (handle: SvnWriteHandle) => Promise<T>, existing?: SvnWriteHandle): Promise<T> {
  if (!root) return Promise.reject(new Error("还没有选择工作副本"));
  const key = keyOfRoot(root);
  const active = writes.get(key);
  if (existing) {
    if (active !== existing || keyOfRoot(existing.root) !== key || existing.kind !== kind) return Promise.reject(new Error("工作副本或写操作已变化，请重新检查"));
    return Promise.resolve().then(() => work(existing));
  }
  if (active) return Promise.reject(new Error("工作副本正在执行写操作，请等待当前操作结束"));
  const handle = { root, kind, startedAt: Date.now() };
  writes.set(key, handle); emit();
  return Promise.resolve().then(() => work(handle)).finally(() => {
    if (writes.get(key) === handle) { writes.delete(key); emit(); }
  });
}
