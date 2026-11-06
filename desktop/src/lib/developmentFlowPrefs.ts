import { DEFAULT_DEVELOPMENT_OPTIONS, type DevelopmentOptions } from "./developmentFlow";
const key = (root: string) => `ncforge-development-flow:${root.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase()}`;
export function readDevelopmentOptions(root: string | null | undefined): DevelopmentOptions {
  if (!root) return { ...DEFAULT_DEVELOPMENT_OPTIONS };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(root)) ?? "null");
    if (!value || typeof value !== "object") return { ...DEFAULT_DEVELOPMENT_OPTIONS };
    const raw = value as Record<string, unknown>, result = { ...DEFAULT_DEVELOPMENT_OPTIONS };
    for (const field of Object.keys(result) as (keyof DevelopmentOptions)[]) if (typeof raw[field] === "boolean") result[field] = raw[field];
    if (!result.debug) result.autoAttach = false;
    return result;
  } catch { return { ...DEFAULT_DEVELOPMENT_OPTIONS }; }
}
export function saveDevelopmentOptions(root: string, options: DevelopmentOptions): void {
  localStorage.setItem(key(root), JSON.stringify({ ...options, autoAttach: options.debug && options.autoAttach }));
}
