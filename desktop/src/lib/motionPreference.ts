import { APP_SLUG } from "./about";

export type MotionPreference = "system" | "reduce";
const KEY = `${APP_SLUG}.motion`;
const EVENT = "motionpreferencechange";
const listeners = new Set<() => void>();
let media: MediaQueryList | undefined;

export function getMotionPreference(): MotionPreference {
  return typeof document !== "undefined" && document.documentElement.dataset.motion === "reduce" ? "reduce" : "system";
}

export function prefersReducedMotion(): boolean {
  return getMotionPreference() === "reduce" || (typeof window !== "undefined"
    && !!(media ?? window.matchMedia?.("(prefers-reduced-motion: reduce)"))?.matches);
}

export function initializeMotionPreference(): void {
  let preference: MotionPreference = "system";
  try { if (localStorage.getItem(KEY) === "reduce") preference = "reduce"; } catch { /* Session preference remains usable. */ }
  document.documentElement.dataset.motion = preference;
}

/** Persistence failure must not prevent the current session from reducing motion. */
export function applyMotionPreference(preference: MotionPreference): boolean {
  document.documentElement.dataset.motion = preference;
  let stored = true;
  try { localStorage.setItem(KEY, preference); } catch { stored = false; }
  window.dispatchEvent(new Event(EVENT));
  return stored;
}

function notify() { listeners.forEach(listener => listener()); }

/** One system listener shared by all controls; the last consumer releases it. */
export function subscribeMotionPreference(listener: () => void): () => void {
  if (!listeners.size) {
    media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (media?.addEventListener) media.addEventListener("change", notify);
    else media?.addListener?.(notify);
    window.addEventListener(EVENT, notify);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    if (media?.removeEventListener) media.removeEventListener("change", notify);
    else media?.removeListener?.(notify);
    window.removeEventListener(EVENT, notify);
    media = undefined;
  };
}
