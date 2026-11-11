import { useSyncExternalStore } from "react";

const KEY = "shell_update_auto_download";
const EVENT = "ncforge-update-download-preference";
let fallback = true;
let sessionOnly = false;
const read = () => { if (sessionOnly) return fallback; try { return localStorage.getItem(KEY) !== "false"; } catch { return fallback; } };
function subscribe(notify: () => void) {
  window.addEventListener(EVENT, notify);
  window.addEventListener("storage", notify);
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener("storage", notify); };
}
export function useUpdateDownloadPreference() {
  return useSyncExternalStore(subscribe, read, () => true);
}
export function setUpdateDownloadPreference(enabled: boolean) {
  fallback = enabled;
  let stored = true;
  try { localStorage.setItem(KEY, String(enabled)); } catch { stored = false; }
  sessionOnly = !stored;
  window.dispatchEvent(new Event(EVENT));
  return stored;
}
