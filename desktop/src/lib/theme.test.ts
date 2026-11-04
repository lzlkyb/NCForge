// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, toggleTheme, type ThemeSaveResult } from "./theme";

const originalTransition = Object.getOwnPropertyDescriptor(document, "startViewTransition");
let updates: (() => void)[];
let observed: { theme: string; dark: boolean }[];
const onTheme = (event: Event) => observed.push({
  theme: (event as CustomEvent<string>).detail,
  dark: document.documentElement.classList.contains("dark"),
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  updates = [];
  observed = [];
  window.addEventListener("themechange", onTheme);
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: (update: () => void) => {
    updates.push(update);
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  } });
});
afterEach(() => {
  window.removeEventListener("themechange", onTheme);
  if (originalTransition) Object.defineProperty(document, "startViewTransition", originalTransition);
  else Reflect.deleteProperty(document, "startViewTransition");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

describe("主题与编辑器同步", () => {
  it("保存结果在动画绘制前通知；保存失败时连切仍以最新选择为准", () => {
    const saves: ThemeSaveResult[] = [];
    const listener = (event: Event) => saves.push((event as CustomEvent<ThemeSaveResult>).detail);
    window.addEventListener("themesave", listener);
    try {
      applyTheme("light");
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
      expect(toggleTheme()).toBe("dark");
      expect(toggleTheme()).toBe("light");
      expect(saves).toEqual([{ theme: "light", stored: true }, { theme: "dark", stored: false }, { theme: "light", stored: false }]);
      updates[2]();
      updates[1]();
      expect(observed).toEqual([{ theme: "light", dark: false }]);
    } finally { window.removeEventListener("themesave", listener); }
  });
  it("在实际应用新主题之后才通知读取样式的编辑器", () => {
    expect(applyTheme("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(observed).toEqual([]);
    updates[0]();
    expect(observed).toEqual([{ theme: "dark", dark: true }]);
  });
  it("快速切换时，延迟的旧主题不能覆盖最后一次选择", () => {
    applyTheme("dark");
    applyTheme("light");
    updates[1]();
    updates[0]();
    expect(observed).toEqual([{ theme: "light", dark: false }]);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
  it("减少动态效果时直接切换并同步通知", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    applyTheme("dark");
    expect(updates).toEqual([]);
    expect(observed).toEqual([{ theme: "dark", dark: true }]);
  });
});
