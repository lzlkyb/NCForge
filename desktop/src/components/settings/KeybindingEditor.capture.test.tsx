// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingEditor } from "./KeybindingEditor";
import { clearSettingsRequest, requestSettingsSection } from "../../lib/settingsJump";
import { clearAllBindings } from "../../lib/keybindings";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const render = (keymap: "eclipse" | "idea") => act(async () => root.render(<KeybindingEditor keymap={keymap} />));
const capturingRow = () => host.querySelector('[data-capturing="true"]');
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
const modify = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === `修改${label}快捷键`)!;
const press = (init: KeyboardEventInit) => act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));

beforeEach(() => {
  clearAllBindings();
  clearSettingsRequest();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearSettingsRequest();
  clearAllBindings();
});

describe("键位采集与跳转请求", () => {
  it("同一跳转 nonce 只武装一次，切键位方案不会重新采集", async () => {
    await render("eclipse");
    await act(async () => requestSettingsSection("快捷键", "palette.file"));
    expect(capturingRow()).not.toBeNull();
    await press({ key: "Escape" });
    expect(capturingRow()).toBeNull();
    await render("idea");
    expect(capturingRow()).toBeNull();
  });
  it("采集态打开全部恢复默认先退出采集，确认框键盘可达", async () => {
    await render("eclipse");
    await act(async () => modify("转到文件").click());
    await press({ key: "9", ctrlKey: true, altKey: true });
    expect(capturingRow()).toBeNull();
    expect(button("全部恢复默认")).toBeTruthy();
    await act(async () => modify("转到文件").click());
    expect(capturingRow()).not.toBeNull();
    await act(async () => button("全部恢复默认").click());
    expect(capturingRow()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "恢复默认")!.click());
    expect(host.textContent).not.toContain("全部恢复默认");
  });
});