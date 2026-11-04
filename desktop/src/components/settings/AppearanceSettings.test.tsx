// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";
import { applyAppearance, getAppearance } from "../../lib/appearance";
import { applyUiDensity, getUiDensity } from "../../lib/uiDensity";
import { applyTheme, toggleTheme } from "../../lib/theme";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const radio = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === text)!;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
    matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) });
  applyAppearance("glass");
  applyUiDensity("standard");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("界面材质设置", () => {
  it("标题栏成功切换后清除旧保存失败提示；再次失败仍明确告知", async () => {
    applyTheme("light");
    await act(async () => root.render(<AppearanceSettings />));
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await act(async () => radio("深色").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法保存");
    storage.mockRestore();
    await act(async () => toggleTheme());
    expect(radio("浅色").getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(localStorage.getItem("theme")).toBe("light");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await act(async () => toggleTheme());
    expect(radio("深色").getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法保存");
  });
  it("明暗主题与标题栏共用状态，预览跟随主题与密度", async () => {
    await act(async () => root.render(<AppearanceSettings />));
    await act(async () => radio("深色").click());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(container.querySelector(".settings-appearance-preview")?.getAttribute("data-theme")).toBe("dark");
    await act(async () => applyTheme("light"));
    expect(radio("浅色").getAttribute("aria-checked")).toBe("true");
    await act(async () => radio("舒适").click());
    expect(container.querySelector(".settings-appearance-preview")?.getAttribute("data-density")).toBe("comfortable");
  });

  it("存储不可用时说明仅本次生效，保留正确主题选择", async () => {
    await act(async () => root.render(<AppearanceSettings />));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await act(async () => radio("深色").click());
    expect(radio("深色").getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("本次会话生效");
  });
  it("密度选项立即生效，外部切换时同步且不改变材质", async () => {
    await act(async () => root.render(<AppearanceSettings />));
    await act(async () => radio("舒适").click());
    expect(getUiDensity()).toBe("comfortable");
    expect(getAppearance()).toBe("glass");
    expect(radio("舒适").getAttribute("aria-checked")).toBe("true");
    await act(async () => applyUiDensity("standard"));
    expect(radio("标准").getAttribute("aria-checked")).toBe("true");
  });
  it("显示当前材质，点击切换后立刻生效并记住", async () => {
    await act(async () => root.render(<AppearanceSettings />));
    expect(radio("柔光玻璃").getAttribute("aria-checked")).toBe("true");

    await act(async () => radio("经典").click());
    expect(getAppearance()).toBe("classic");
    expect(radio("经典").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("ncforge.ui-style")).toBe("classic");
    expect(container.querySelector(".settings-appearance-preview")?.getAttribute("data-material")).toBe("classic");
    await act(async () => radio("柔光玻璃").click());
    expect(getAppearance()).toBe("glass");
    expect(container.querySelector(".settings-appearance-preview")?.getAttribute("data-material")).toBe("glass");
  });

  it("外部切换（其它入口）时选项跟着同步", async () => {
    await act(async () => root.render(<AppearanceSettings />));
    await act(async () => applyAppearance("classic"));
    expect(radio("经典").getAttribute("aria-checked")).toBe("true");
  });
});
