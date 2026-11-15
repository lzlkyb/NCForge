import { useSyncExternalStore } from "react";

export interface JavaTemplate { prefix: string; detail: string; body: string; enabled?: boolean; }
const KEY = "ncforge-java-templates-v1";
const listeners = new Set<() => void>();
let templates: JavaTemplate[] = read();

function read(): JavaTemplate[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(valid).slice(0, 100) : [];
  } catch { return []; }
}

function valid(value: unknown): value is JavaTemplate {
  if (!value || typeof value !== "object") return false;
  const item = value as JavaTemplate;
  return typeof item.prefix === "string" && /^[a-z][\w]*$/.test(item.prefix) && item.prefix.length <= 40
    && typeof item.detail === "string" && item.detail.length <= 200 && typeof item.body === "string"
    && item.body.length > 0 && item.body.length <= 32_768 && (item.enabled === undefined || typeof item.enabled === "boolean");
}

export function getJavaTemplates(): JavaTemplate[] { return templates; }

export function effectiveJavaTemplates(builtins: readonly JavaTemplate[]): JavaTemplate[] {
  const merged = new Map(builtins.map(item => [item.prefix, item]));
  for (const item of templates) merged.set(item.prefix, item);
  return [...merged.values()].filter(item => item.enabled !== false);
}

export function saveJavaTemplate(item: JavaTemplate): void {
  if (!valid(item)) throw new Error("前缀需以小写字母开头，只含字母数字下划线；模板内容不能为空或超过 32KB");
  const next = templates.filter(existing => existing.prefix !== item.prefix);
  if (next.length >= 100) throw new Error("最多保存 100 个自定义模板");
  persist([...next, { ...item }]);
}

export function deleteJavaTemplate(prefix: string): void { persist(templates.filter(item => item.prefix !== prefix)); }

export function getJavaFileHeader(): string {
  try { return localStorage.getItem("ncforge-java-file-header") ?? ""; } catch { return ""; }
}
export function saveJavaFileHeader(header: string): boolean {
  try { localStorage.setItem("ncforge-java-file-header", header); return true; } catch { return false; }
}

function persist(next: JavaTemplate[]): void {
  // 写入失败时保持上一份状态，不能显示“已保存”却在重启后丢失。
  localStorage.setItem(KEY, JSON.stringify(next));
  templates = next;
  for (const listener of listeners) listener();
}

export function useJavaTemplates(): JavaTemplate[] {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getJavaTemplates, getJavaTemplates);
}
