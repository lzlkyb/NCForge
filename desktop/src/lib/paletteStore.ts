import { useSyncExternalStore } from "react";
import type { PaletteMode } from "./keymap";

/**
 * 快速导航浮层的开关与模式。触发入口（快捷键、标题栏输入框、输入框里敲 `>` / `@`）分散在不同组件，
 * 统一走这个仓库。`nonce` 每次打开 / 切模式都自增，让浮层能在「已经开着」时也清空查询重来。
 */
export interface PaletteState {
  open: boolean;
  mode: PaletteMode;
  nonce: number;
}

let state: PaletteState = { open: false, mode: "file", nonce: 0 };
const listeners = new Set<() => void>();

function set(next: PaletteState): void {
  state = next;
  listeners.forEach((l) => l());
}

export function openPalette(mode: PaletteMode): void {
  set({ open: true, mode, nonce: state.nonce + 1 });
}

export function closePalette(): void {
  if (state.open) set({ ...state, open: false });
}

export function getPalette(): PaletteState {
  return state;
}

export function usePalette(): PaletteState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getPalette,
    getPalette,
  );
}
