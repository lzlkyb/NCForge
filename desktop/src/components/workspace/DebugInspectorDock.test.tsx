// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ add: vi.fn(), set: vi.fn(), expand: vi.fn() }));
vi.mock("../../lib/debugSession", () => ({ MAX_DEBUG_WATCHES: 12, addWatch: mocks.add, removeWatch: vi.fn(), expandVariables: mocks.expand, setVariableValue: mocks.set }));
import { DebugInspectorContent, DebugInspectorDock } from "./DebugInspectorDock";
import { updateWorkbenchLayout } from "../../lib/workbenchLayout";
import type { DebugSnapshot } from "../../lib/debugSession";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, resize: ResizeObserverCallback;
const snap = {
  target: "server", paused: true, frames: [], frameId: null, watches: [],
  scopes: [{ name: "local", variablesReference: 1, expensive: false }],
  variables: { 1: [{ name: "vo", value: "Object", variablesReference: 2 }], 2: [{ name: "code", value: "saved", variablesReference: 0 }] },
} as unknown as DebugSnapshot;
const typeInto = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const width = (value: number) => act(async () => resize([{ contentRect: { width: value } } as ResizeObserverEntry], {} as ResizeObserver));
beforeEach(async () => {
  vi.clearAllMocks(); updateWorkbenchLayout({ mode: "debug", locked: false });
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<div><DebugInspectorDock /><DebugInspectorContent snap={snap} /></div>));
  await width(1200);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("wide/narrow relocation preserves the single watch input, draft, focus and expanded variable", async () => {
  const input = host.querySelector<HTMLInputElement>(".dbg-watch-input")!;
  await typeInto(input, "vo.getCode()");
  await act(async () => host.querySelector<HTMLButtonElement>(".dbg-var")!.click());
  input.focus();
  await width(500);
  expect(host.querySelector(".dw-debug-inline")?.contains(input)).toBe(true);
  expect(document.activeElement).toBe(input); expect(input.value).toBe("vo.getCode()"); expect(host.querySelector(".dbg-var[aria-expanded=true]")).not.toBeNull();
  await width(1200);
  expect(host.querySelector(".dw-debug-dock")?.contains(input)).toBe(true); expect(document.activeElement).toBe(input); expect(host.querySelectorAll(".dbg-watch-input")).toHaveLength(1);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })));
  expect(mocks.add).not.toHaveBeenCalled(); expect(input.value).toBe("vo.getCode()");
});
it("moving a focused variable editor cannot commit its unfinished draft", async () => {
  await act(async () => host.querySelector<HTMLButtonElement>(".dbg-var-edit")!.click());
  const input = host.querySelector<HTMLInputElement>(".dbg-var-edit-row input")!;
  await typeInto(input, "unfinished");
  input.focus(); await width(500); await width(1200);
  expect(document.activeElement).toBe(input); expect(input.value).toBe("unfinished"); expect(mocks.set).not.toHaveBeenCalled();
  const container = input.closest(".dw-debug-inspector")!.parentElement!;
  container.dataset.relocating = "true";
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(mocks.set).not.toHaveBeenCalled(); delete container.dataset.relocating;
});
