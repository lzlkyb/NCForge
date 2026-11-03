import { useSyncExternalStore } from "react";

/**
 * 跨工程打开时是否跳过确认、直接切换。
 *
 * 与 `treeViewPrefs` 的开关相反：这个默认**关**。切换会关掉全部标签、重启 jdt.ls
 * 重建索引（3~8 秒），首次遇到的人需要先看清代价；确认框里勾一次以后就是熟路。
 * 存在 localStorage：这是本机习惯，不随工程配置走。
 */
const KEY = "ncforge.tree.directSwitch";

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

let value = read();
const listeners = new Set<() => void>();

export const getDirectSwitch = (): boolean => value;

export const setDirectSwitch = (on: boolean): void => {
  if (on === value) return;
  value = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // 隐私模式：本次会话仍生效
  }
  for (const l of listeners) l();
};

export const toggleDirectSwitch = (): void => setDirectSwitch(!value);

export function useDirectSwitch(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getDirectSwitch,
    getDirectSwitch,
  );
}
