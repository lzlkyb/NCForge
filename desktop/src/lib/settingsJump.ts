import { useSyncExternalStore } from "react";

/**
 * 「跳到设置里的某一项」的请求。
 *
 * 快捷键一览（`?`）和命令面板都要能把用户送到设置页的具体分类：前者点一行就能
 * 直接开始改键，后者从命令跳到对应设置。设置页是懒加载的，事件发出去时组件可能
 * 还没挂上；用模块级请求而不是一次性的 window 事件，挂载后还能读到。
 */
export interface SettingsRequest {
  /** 分类名，与 `SettingsSection.label` 一致。 */
  section: string;
  /** 要在分类里点亮的键位 id（只对「快捷键」分类有意义）。 */
  binding?: string;
  /** Stable setting id, including items moved to a new category. */
  itemId?: string;
  /** 每次请求递增：连续请求同一个分类也要能再次触发高亮。 */
  nonce: number;
}

let current: SettingsRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function requestSettingsSection(section: string, binding?: string): void {
  current = { section, binding, nonce: ++nonce };
  emit();
}

export function requestSettingItem(section: string, itemId: string): void {
  current = { section, itemId, nonce: ++nonce };
  emit();
}

export function clearSettingsRequest(): void {
  if (!current) return;
  current = null;
  emit();
}

export function getSettingsRequest(): SettingsRequest | null {
  return current;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useSettingsRequest(): SettingsRequest | null {
  return useSyncExternalStore(subscribe, getSettingsRequest, getSettingsRequest);
}
