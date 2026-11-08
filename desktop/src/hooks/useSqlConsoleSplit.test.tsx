// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSqlConsoleSplit } from "./useSqlConsoleSplit";

let resize: () => void, bodyHeight = 600;
let root: Root, host: HTMLDivElement;
const disconnect = vi.fn();
function Harness({ tabId = "a" }: { tabId?: string }) {
  const split = useSqlConsoleSplit(tabId);
  return <div ref={split.bodyRef}><div data-height={split.height} data-focus={split.focus} data-result-height={split.resultHeight} /><div role="separator" aria-valuenow={split.height}
    onKeyDown={split.onKeyDown} onPointerDown={e => split.startDrag(e.clientY)} />
    <button onClick={() => split.setFocus("results")}>专注结果</button>
    <button onClick={() => split.setFocus("editor")}>专注编辑器</button>
    <button onClick={() => split.setFocus("split")}>还原布局</button>
  </div>;
}
beforeEach(() => {
  bodyHeight = 600; localStorage.clear(); disconnect.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect = disconnect; });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => bodyHeight);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const mount = () => act(() => root.render(<Harness />));
const height = () => Number(host.querySelector("[data-height]")?.getAttribute("data-height"));
const key = (value: string) => act(() => host.querySelector('[role="separator"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
const focus = (label: string) => act(() => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
it("窗口变矮限制结果高度并计入分隔条，恢复窗口后保留原来的高度偏好", () => {
  mount(); expect(height()).toBe(300);
  bodyHeight = 287; act(() => resize()); expect(height()).toBe(142);
  bodyHeight = 600; act(() => resize()); expect(height()).toBe(300);
});
it.each(["Infinity", "-30", "invalid"])("损坏的保存高度 %s 不破坏编辑区", value => {
  localStorage.setItem("ncforge-db-result-height", value); mount(); expect(height()).toBe(300);
});
it("键盘调整遵守当前高度限制并保存偏好", () => {
  mount(); bodyHeight = 287; act(() => resize()); key("End");
  expect(height()).toBe(142); expect(localStorage.getItem("ncforge-db-result-height")).toBe("142");
  key("Home"); expect(height()).toBe(90);
});
it("隐藏再显示不会将高度偏好清零，卸载释放尺寸监听", () => {
  mount(); bodyHeight = 0; act(() => resize()); bodyHeight = 600; act(() => resize()); expect(height()).toBe(300);
  act(() => root.unmount()); root = createRoot(host); expect(disconnect).toHaveBeenCalledOnce();
});
it("拖动不能吞掉输入区，取消指针后保存并移除拖动监听", () => {
  mount();
  act(() => host.querySelector('[role="separator"]')!.dispatchEvent(new MouseEvent("pointerdown", { clientY: 300, buttons: 1, bubbles: true })));
  act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientY: 0, buttons: 1 })));
  expect(height()).toBe(455);
  act(() => window.dispatchEvent(new Event("pointercancel")));
  expect(localStorage.getItem("ncforge-db-result-height")).toBe("455");
  act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientY: 400, buttons: 1 })));
  expect(height()).toBe(455);
});

it("专注结果与编辑器不覆盖分隔比例，恢复后仍使用原偏好", () => {
  mount(); key("ArrowUp"); expect(height()).toBe(316);
  focus("专注结果");
  expect(host.querySelector("[data-focus]")?.getAttribute("data-focus")).toBe("results");
  expect(host.querySelector("[data-result-height]")?.getAttribute("data-result-height")).toBe("600");
  expect(localStorage.getItem("ncforge-db-result-height")).toBe("316");
  focus("专注编辑器");
  expect(host.querySelector("[data-focus]")?.getAttribute("data-focus")).toBe("editor");
  focus("还原布局"); expect(height()).toBe(316);
});

it("切换 SQL 标签分别保留专注模式与分隔比例", () => {
  mount(); key("ArrowUp"); focus("专注结果");
  act(() => root.render(<Harness tabId="b" />));
  expect(host.querySelector("[data-focus]")?.getAttribute("data-focus")).toBe("split");
  expect(height()).toBe(300);
  key("ArrowDown"); focus("专注编辑器");
  act(() => root.render(<Harness tabId="a" />));
  expect(host.querySelector("[data-focus]")?.getAttribute("data-focus")).toBe("results");
  expect(height()).toBe(316);
  focus("还原布局");
  act(() => root.render(<Harness tabId="b" />));
  expect(host.querySelector("[data-focus]")?.getAttribute("data-focus")).toBe("editor");
  expect(height()).toBe(284);
});
