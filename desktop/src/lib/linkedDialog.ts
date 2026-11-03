import { useSyncExternalStore } from "react";

/** 弹框里三个区块；从问题面板跳进来时直接滚到对应的那一块。 */
export type LinkedSection = "chain" | "overrides" | "artifacts";

interface LinkedDialogState {
  open: boolean;
  section: LinkedSection;
}

/**
 * 「工程关联」弹框的开关。
 *
 * 页面摘掉之后，入口分散在三处（代码页状态栏、问题面板诊断行、命令面板），
 * 都是「打开弹框」而不是「切页」。放模块级而不是 App state：
 * 问题面板在文件页深处，命令面板在 App，两处要能开同一个弹框。
 *
 * 快照必须是稳定引用：`useSyncExternalStore` 每次渲染都调 getSnapshot，
 * 返回新对象会触发无限重渲染（与 workspaceSession 同一口径）。
 */
let state: LinkedDialogState = { open: false, section: "chain" };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openLinkedDialog(section: LinkedSection = "chain"): void {
  state = { open: true, section };
  emit();
}

export function closeLinkedDialog(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
}

export function useLinkedDialog(): LinkedDialogState {
  return useSyncExternalStore(subscribe, () => state);
}
