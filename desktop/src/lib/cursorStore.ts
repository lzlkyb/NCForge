import { useSyncExternalStore } from "react";

/** 光标位置（1 基）。 */
export interface CursorPos {
  line: number;
  column: number;
}

/**
 * 光标位置的独立小仓库。
 *
 * 以前它躺在 `FilesTab` 的 useState 里：每按一次方向键就 setState，整页重渲染——
 * 包括未 memo 的整棵文件树。深目录下按住方向键就是每秒几十次全树 reconciliation。
 * 光标只有状态栏要，放进独立仓库后订阅者只剩 `EditorStatus` 一个。
 */
let cursor: CursorPos = { line: 1, column: 1 };
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const snapshot = (): CursorPos => cursor;

export function setCursor(line: number, column: number): void {
  if (cursor.line === line && cursor.column === column) return;
  cursor = { line, column };
  listeners.forEach((l) => l());
}

export function useCursor(): CursorPos {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * 读当前光标位置，不订阅。
 *
 * 给「跳到下一处问题」「重命名」这类**按需执行**的动作用：它们只需要执行那一刻的位置，
 * 订阅反而会让文件页跟着每次方向键重渲染（这个仓库存在的意义就是避免那件事）。
 */
export function getCursor(): CursorPos {
  return cursor;
}
