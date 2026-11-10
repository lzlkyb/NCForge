import { useSyncExternalStore } from "react";

const KEY = "shell_update_auto_download";
const EVENT = "ncforge-update-download-preference";
let fallback = true;
const read = () => { try { return localStorage.getItem(KEY) !== "false"; } catch { return fallback; } };
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
  try { localStorage.setItem(KEY, String(enabled)); } catch { /* 本次运行仍保留用户选择。 */ }
  window.dispatchEvent(new Event(EVENT));
}
