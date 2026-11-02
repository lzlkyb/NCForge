// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";
import { applyAppearance, getAppearance } from "../../lib/appearance";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const radio = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === text)!;

beforeEach(() => {
  localStorage.clear();
  applyAppearance("glass");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("界面材质设置", () => {
  it("显示当前材质，点击切换后立刻生效并记住", async () => {
    await act(async () => root.render(<AppearanceSettings />));
    expect(radio("玻璃").getAttribute("aria-checked")).toBe("true");

    await act(async () => radio("经典").click());
    expect(getAppearance()).toBe("classic");
    expect(radio("经典").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("ncforge.ui-style")).toBe("classic");
  });

  it("外部切换（其它入口）时选项跟着同步", async () => {
    await act(async () => root.render(<AppearanceSettings />));
    await act(async () => applyAppearance("classic"));
    expect(radio("经典").getAttribute("aria-checked")).toBe("true");
  });
});
