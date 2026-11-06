import { APP_SLUG } from "./about";

export type UiDensity = "standard" | "comfortable";
const KEY = `${APP_SLUG}.ui-density`;
const EVENT = "ui-density-change";

export function getStoredUiDensity(): UiDensity {
  try { return localStorage.getItem(KEY) === "comfortable" ? "comfortable" : "standard"; }
  catch { return "standard"; }
}

export function getUiDensity(): UiDensity {
  return document.documentElement.dataset.uiDensity === "comfortable" ? "comfortable" : "standard";
}

/** 编辑器保留自己的字号；虚拟列表接入密度时须同时订阅变化并同步行几何。 */
export function initializeUiDensity(): void {
  document.documentElement.dataset.uiDensity = getStoredUiDensity();
}

export function applyUiDensity(density: UiDensity): boolean {
  const changed = getUiDensity() !== density;
  document.documentElement.dataset.uiDensity = density;
  let saved = true;
  try { localStorage.setItem(KEY, density); } catch { saved = false; }
  if (changed) window.dispatchEvent(new Event(EVENT));
  return saved;
}

export function subscribeUiDensity(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
