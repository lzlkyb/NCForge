import { useSyncExternalStore } from "react";
import { APP_SLUG } from "./about";

type Result = { from: string; to: string; status: "confirmed" | "pending" | "failed"; at: number };
const key = `${APP_SLUG}.last_update_result`;
const listeners = new Set<() => void>();
let fallback: string | null = null;
let sessionOnly = false;
function read() {
  if (sessionOnly) return fallback;
  try { return localStorage.getItem(key); } catch { return fallback; }
}

export function recordUpdateResult(result: Omit<Result, "at">) {
  fallback = JSON.stringify({ ...result, at: Date.now() });
  try { localStorage.setItem(key, fallback); sessionOnly = false; } catch { sessionOnly = true; }
  listeners.forEach(listener => listener());
}

export function readUpdateResult(): Result | null {
  try { return JSON.parse(read() ?? "null") as Result | null; } catch { return null; }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLastUpdateResult(): Result | null {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  try { return JSON.parse(raw ?? "null") as Result | null; } catch { return null; }
}
