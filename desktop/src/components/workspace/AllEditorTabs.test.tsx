// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AllEditorTabs } from "./AllEditorTabs";
import type { TabMeta } from "../../lib/workspaceSession";
const h = vi.hoisted(() => ({ state: { editorGroups: { recent: ["C:\\w\\B.java", "C:\\w\\a\\A.java"] } }, select: vi.fn() }));
vi.mock("../../lib/workspaceSession", () => ({ useWorkspaceSelector: (selector: (state: typeof h.state) => unknown) => selector(h.state) }));
vi.mock("../../hooks/usePresence", () => ({ usePresence: (open: boolean) => ({ mounted: open, entered: true }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tabs = [{ path: "C:\\w\\a\\A.java", name: "A.java", pinned: true }, { path: "C:\\w\\b\\A.java", name: "A.java", dirty: true }, { path: "C:\\w\\B.java", name: "B.java", eolChanged: true }] as unknown as TabMeta[];
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  h.select.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<AllEditorTabs root="C:\\w" tabs={tabs} activePath={tabs[0].path} onSelect={h.select} />));
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="所有标签"]')!.click());
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const menuItems = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
const clickText = (text: string) => act(() => Array.from(document.querySelectorAll("button")).find(button => button.textContent === text)!.click());
it("最近使用排序把未访问文件排在最后，键盘选中同名文件能定位准确路径", () => {
  clickText("最近使用");
  expect(menuItems().map(item => item.querySelector(".wb-tabs-menu-name")?.textContent)).toEqual(["B.java", "A.java", "A.java"]);
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索打开的文件"]')!; search.focus();
  act(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.activeElement).toBe(menuItems()[0]);
  act(() => menuItems()[2].click());
  expect(h.select).toHaveBeenCalledExactlyOnceWith(tabs[1].path);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
it("文件名和路径搜索可叠加未保存筛选，空结果明确说明恢复方式", () => {
  clickText("仅未保存"); expect(menuItems()).toHaveLength(2);
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索打开的文件"]')!;
  const change = (value: string) => act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value); search.dispatchEvent(new Event("input", { bubbles: true })); });
  change("\\b\\"); expect(menuItems()).toHaveLength(1); expect(menuItems()[0].textContent).toContain("A.java");
  change("missing"); expect(menuItems()).toHaveLength(0); expect(document.body.textContent).toContain("没有匹配文件，请调整筛选");
  change(""); expect(menuItems()).toHaveLength(2);
});
