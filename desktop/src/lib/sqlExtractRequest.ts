import { useSyncExternalStore } from "react";
import type { Extracted } from "./sqlExtract";

/** Java 编辑器右键「在数据库中执行 / 查看执行计划 / 复制为纯 SQL」的请求，由 ExtractSqlDialog 接。 */

export type ExtractMode = "run" | "explain" | "copy";

export interface ExtractRequest extends Extracted {
  /** 来源文件（记参数值用）。 */
  file: string;
  mode: ExtractMode;
}

let req: ExtractRequest | null = null;
const listeners = new Set<() => void>();

export function requestExtract(r: ExtractRequest | null) {
  req = r;
  listeners.forEach((fn) => fn());
}

export function useExtractRequest(): ExtractRequest | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => req,
  );
}

const KEY = "ncforge-sql-params";

/** 填过的参数值按「文件 + 参数名」记住。 */
export function loadParamValues(file: string): Record<string, string> {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Record<string, string>>)[file] ?? {};
  } catch {
    return {};
  }
}

export function saveParamValues(file: string, values: Record<string, string>) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Record<string, string>>;
    all[file] = { ...(all[file] ?? {}), ...values };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存不下就不记
  }
}
