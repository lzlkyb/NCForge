import { getOperations, subscribeOperations, trackOperation } from "./operations";
import { invoke, listen } from "./tauri";
import { formatBytes } from "./utils";

export const STORAGE_SECTION = "存储与性能";
export type StorageScope = "recommended" | "language";
export type StorageCategory = "temporary" | "cache" | "components" | "local";
export type StorageUsage = {
  categories: Record<StorageCategory, { bytes: number; incomplete: boolean }>;
  freeBytes: number | null;
  totalBytes: number | null;
  sampledAt: number;
  languageBusy: boolean;
};
export type StoragePreview = {
  id: number;
  incomplete: boolean;
  entries: { key: number; kind: "compile" | "download" | "log" | "language"; name: string; bytes: number;
    workspace?: string | null; lastUsed?: number | null }[];
};
export type StorageReport = {
  removedBytes: number;
  removed: number;
  skipped: number;
  cancelled: boolean;
  reasons: Partial<Record<"changed" | "unsafe" | "access" | "busy", number>>;
};
export type MemorySnapshot = {
  sampledAt: number;
  rows: { group: "main" | "webview" | "language" | "compiler" | "database" | "other"; pid: number;
    residentBytes: number | null; privateBytes: number | null }[];
  idleCompilers: number;
  partial: boolean;
};

const autoKey = "ncforge-storage-auto";
const receiptKey = "ncforge-storage-last-auto";
export const currentStorageUsage = () => invoke<StorageUsage>("storage_usage");
export const previewStorage = (scope: StorageScope) => invoke<StoragePreview>("storage_preview", { scope });
export const sampleMemory = () => invoke<MemorySnapshot>("storage_memory");
export const releaseIdleCompilers = () => invoke<number>("storage_release_compilers");
export const autoStorageEnabled = () => localStorage.getItem(autoKey) !== "off";
export const setAutoStorage = (enabled: boolean) => localStorage.setItem(autoKey, enabled ? "on" : "off");

export function storageReceipt(report: StorageReport): string {
  return `已移除 ${formatBytes(report.removedBytes)} · ${report.removed} 项${report.skipped ? ` · ${report.skipped} 项未完整移除` : ""}`;
}

export async function applyStorage(planId: number, selected: number[]): Promise<StorageReport> {
  return trackOperation({
    key: "storage.cleanup", label: "清理本机存储", page: "settings", phase: "正在复核清理清单",
    cancel: () => invoke("storage_cancel", { planId }),
  }, async handle => {
    const off = await listen<{ planId: number; done: number; total: number }>("storage-clean-progress", progress => {
      if (progress.planId === planId) handle.update({ phase: "清理已选项目",
        progress: { done: progress.done, total: progress.total, unit: "项" } });
    });
    try { return await invoke<StorageReport>("storage_apply", { planId, selected }); }
    finally { off(); }
  }, result => ({
    state: result.cancelled ? "cancelled" : result.skipped ? "partial" : "success", detail: storageReceipt(result),
  }));
}

const AUTO_INTERVAL = 24 * 60 * 60 * 1000;
const IDLE_TIME = 2 * 60 * 1000;

export function wireStorageMaintenance(): () => void {
  let lastActivity = Date.now();
  let inFlight = false;
  let interruptSent = false;
  let nextAttempt = 0;
  const interrupt = () => {
    if (inFlight && !interruptSent) {
      interruptSent = true;
      void invoke("storage_cancel", { planId: 0 }).catch(() => {});
    }
  };
  const onInput = () => { lastActivity = Date.now(); interrupt(); };
  const busy = () => getOperations().some(task => task.endedAt === undefined);
  const check = async () => {
    const now = Date.now();
    if (inFlight || now < nextAttempt || now - lastActivity < IDLE_TIME || !autoStorageEnabled()) return;
    if (busy()) return;
    const last = Number(localStorage.getItem(receiptKey)) || 0;
    if (now - last < AUTO_INTERVAL) return;
    inFlight = true;
    interruptSent = false;
    nextAttempt = now + IDLE_TIME;
    try {
      const report = await invoke<StorageReport>("storage_idle_cleanup");
      if (!report.cancelled) localStorage.setItem(receiptKey, String(Date.now()));
    } catch { /* A competing cleanup leaves this maintenance eligible for the next idle window. */ }
    finally { inFlight = false; }
  };
  const events = ["keydown", "pointerdown", "wheel", "focus"] as const;
  events.forEach(event => window.addEventListener(event, onInput, { passive: true }));
  const unsubscribe = subscribeOperations(() => { if (inFlight && busy()) interrupt(); });
  const timer = window.setInterval(() => void check(), 60_000);
  return () => {
    window.clearInterval(timer);
    unsubscribe();
    events.forEach(event => window.removeEventListener(event, onInput));
    if (inFlight) void invoke("storage_cancel", { planId: 0 }).catch(() => {});
  };
}
