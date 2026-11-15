// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { applyMotionPreference, getMotionPreference, initializeMotionPreference, prefersReducedMotion } from "./motionPreference";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { transitionPage } from "./pageTransition";
import { applyTheme } from "./theme";
import { applyAppearance } from "./appearance";
import { APP_SLUG } from "./about";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const changes = new Set<() => void>();
const media = { matches: false, addEventListener: vi.fn((_name: string, fn: () => void) => changes.add(fn)),
  removeEventListener: vi.fn((_name: string, fn: () => void) => changes.delete(fn)) };
function Preference() { return <span>{usePrefersReducedMotion() ? "减少" : "正常"}</span>; }
beforeEach(() => {
  localStorage.clear(); delete document.documentElement.dataset.motion;
  media.matches = false; changes.clear(); vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => media);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete document.documentElement.dataset.motion;
  delete document.documentElement.dataset.materialTransitions;
  delete document.documentElement.dataset.pageTransitions;
  document.documentElement.classList.remove("theme-transition");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("restores local preference before rendering and still works when storage rejects writes", () => {
  localStorage.setItem(`${APP_SLUG}.motion`, "reduce");
  initializeMotionPreference();
  expect(getMotionPreference()).toBe("reduce");
  expect(prefersReducedMotion()).toBe(true);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(applyMotionPreference("system")).toBe(false);
  expect(getMotionPreference()).toBe("system");
  expect(prefersReducedMotion()).toBe(false);
});

it("shares the system listener and updates mounted controls from both preference sources", async () => {
  await act(async () => root.render(<><Preference /><Preference /></>));
  expect(media.addEventListener).toHaveBeenCalledTimes(1);
  expect(host.textContent).toBe("正常正常");
  await act(async () => { media.matches = true; changes.forEach(notify => notify()); });
  expect(host.textContent).toBe("减少减少");
  await act(async () => applyMotionPreference("reduce"));
  await act(async () => { media.matches = false; changes.forEach(notify => notify()); });
  expect(host.textContent).toBe("减少减少");
  await act(async () => applyMotionPreference("system"));
  expect(host.textContent).toBe("正常正常");
  await act(async () => root.render(null));
  expect(media.removeEventListener).toHaveBeenCalledTimes(1);
});

it("local reduced motion bypasses page, theme, and material snapshots", () => {
  const capture = vi.fn();
  Object.defineProperty(document, "startViewTransition", { value: capture, configurable: true });
  applyMotionPreference("reduce");
  const update = vi.fn();
  transitionPage(update); applyTheme("dark"); applyAppearance("glass");
  expect(update).toHaveBeenCalledOnce();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.dataset.uiStyle).toBe("glass");
  expect(capture).not.toHaveBeenCalled();
});

it("a failed browser snapshot never blocks navigation or applying a theme", () => {
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: () => { throw new Error("capture unavailable"); } });
  const update = vi.fn();
  expect(() => transitionPage(update)).not.toThrow();
  expect(update).toHaveBeenCalledOnce();
  expect(applyTheme("light")).toBe(true);
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});
