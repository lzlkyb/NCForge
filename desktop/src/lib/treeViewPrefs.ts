import { useSyncExternalStore } from "react";

/**
 * 文件树的显示偏好。都是本机界面习惯，存 localStorage，不随配置迁移走；默认都开，
 * 升级后保持原来的行为。
 *
 * - `compactPackages`：`com → aier → erp` 这种「只有一个子目录」的链条压成一行
 *   （对标 IDEA Compact Middle Packages / Eclipse Flat）；
 * - `revealOnOpen`：右边打开文件时，左边自动展开并滚到那一行；
 * - `ncStructure`：NC 结构视图，业务组件模块的 `src` 层摊平（默认**关**：
 *   它依赖 `manifest.xml`，没有登记表的工程开了也不会有任何变化）。
 */
function createPref(key: string, def = true) {
  const read = () => {
    try {
      // 只认明确的那一个值：默认开的认 "0" 为关，默认关的认 "1" 为开，
      // 键不存在或被改坏都回默认，不把垃圾值当成「反默认」
      return def
        ? localStorage.getItem(key) !== "0"
        : localStorage.getItem(key) === "1";
    } catch {
      return def;
    }
  };
  let value = read();
  const listeners = new Set<() => void>();
  const get = () => value;
  const set = (on: boolean) => {
    if (on === value) return;
    value = on;
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      // 隐私模式 / 存储满：本次会话仍生效，下次启动回默认
    }
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  return { get, set, subscribe };
}

const compactPref = createPref("ncforge.tree.compactPackages");
const revealPref = createPref("ncforge.tree.revealOnOpen");
const ncStructurePref = createPref("ncforge.tree.ncStructure", false);

export const getCompactPackages = compactPref.get;
export const setCompactPackages = compactPref.set;
export const toggleCompactPackages = () => compactPref.set(!compactPref.get());
export function useCompactPackages(): boolean {
  return useSyncExternalStore(compactPref.subscribe, compactPref.get);
}

export const getRevealOnOpen = revealPref.get;
export const setRevealOnOpen = revealPref.set;
export const toggleRevealOnOpen = () => revealPref.set(!revealPref.get());
export function useRevealOnOpen(): boolean {
  return useSyncExternalStore(revealPref.subscribe, revealPref.get);
}

export const setNcStructure = ncStructurePref.set;
export const toggleNcStructure = () => ncStructurePref.set(!ncStructurePref.get());
export function useNcStructure(): boolean {
  return useSyncExternalStore(ncStructurePref.subscribe, ncStructurePref.get);
}

const packagePref = createPref("ncforge.tree.packageView", false);
export const setPackageView = packagePref.set;
export const togglePackageView = () => packagePref.set(!packagePref.get());
export function usePackageView(): boolean {
  return useSyncExternalStore(packagePref.subscribe, packagePref.get);
}
