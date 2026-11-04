// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAppearance, getAppearance, getStoredAppearance, initializeAppearance } from "./appearance";

beforeEach(() => { localStorage.clear(); delete document.documentElement.dataset.uiStyle; });
afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.uiStyle;
  delete document.documentElement.dataset.materialTransitions;
  Reflect.deleteProperty(document, "startViewTransition");
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(window, "matchMedia");
});

describe("一体化界面默认材质", () => {
  it("新用户默认使用实色，初始化不写入偏好", () => {
    initializeAppearance();
    expect(getAppearance()).toBe("classic");
    expect(localStorage.getItem("ncforge.ui-style")).toBeNull();
  });
  it.each(["classic", "glass"])("尊重已保存的 %s 材质", (appearance) => {
    localStorage.setItem("ncforge.ui-style", appearance);
    initializeAppearance();
    expect(getAppearance()).toBe(appearance);
  });
  it("存储不可用时仍能得到实色默认值", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
    expect(getStoredAppearance()).toBe("classic");
  });
});

describe("材质切换动效", () => {
  const allowMotion = () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
  };
  it("快速切回经典时，过期快照不能覆盖最后的选择", () => {
    allowMotion();
    let paint: () => void = () => {};
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: (callback: () => void) => {
      paint = callback;
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    } });
    applyAppearance("glass");
    applyAppearance("classic");
    paint();
    expect(getAppearance()).toBe("classic");
    expect(localStorage.getItem("ncforge.ui-style")).toBe("classic");
  });
  it("快照接口失败仍完成切换，存储失败仍显示当前材质", () => {
    allowMotion();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: () => { throw new Error("unavailable"); } });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(applyAppearance("glass")).toBe(false);
    expect(getAppearance()).toBe("glass");
    expect(document.documentElement.hasAttribute("data-material-transitions")).toBe(false);
  });
  it("减少动态效果时直接切换，不启动快照", () => {
    allowMotion();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
    const start = vi.fn();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    applyAppearance("glass");
    expect(getAppearance()).toBe("glass");
    expect(start).not.toHaveBeenCalled();
  });
});
