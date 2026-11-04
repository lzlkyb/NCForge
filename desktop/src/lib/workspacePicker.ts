import { useSyncExternalStore } from "react";

interface WorkspacePick {
  path?: string;
  nonce: number;
}
let pending: WorkspacePick | null = null;
let nonce = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const snapshot = () => pending;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 文件页可能尚未加载，先保留请求，再由它已有的保存/切换流程消费。 */
export function requestWorkspacePicker(path?: string): void {
  pending = { path, nonce: ++nonce };
  emit();
}
export function clearWorkspacePicker(consumed: number): void {
  if (pending?.nonce !== consumed) return;
  pending = null;
  emit();
}
export function useWorkspacePick() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
