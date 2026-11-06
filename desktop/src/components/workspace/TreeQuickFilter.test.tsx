// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { treeFilterFor, useTreeFilterState } from "../../lib/treeFilter";
import { TreeQuickFilter } from "./TreeQuickFilter";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => dispose());
it("过滤入口打开后聚焦；Escape 清除过滤并恢复入口焦点", async () => {
  const store = treeFilterFor("D:/quick-filter-test"); store.set({ open: true, text: "Demo" });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  dispose = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => root.render(<><button aria-label="过滤资源树入口">过滤</button><TreeQuickFilter root="D:/quick-filter-test" /></>));
  const input = host.querySelector<HTMLInputElement>("input")!;
  expect(document.activeElement).toBe(input); expect(input.value).toBe("Demo");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(store.get()).toEqual({ open: false, text: "" });
  expect(document.activeElement).toBe(host.querySelector("button"));
});
it("组合输入期间 Escape 不清除用户过滤草稿", async () => {
  const store = treeFilterFor("D:/quick-filter-ime"); store.set({ open: true, text: "客户" });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  dispose = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => root.render(<TreeQuickFilter root="D:/quick-filter-ime" />));
  await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
  expect(store.get()).toEqual({ open: true, text: "客户" });
});
it("过滤写入函数跨重渲染稳定，切换工程后只清理当前工程", async () => {
  const first = treeFilterFor("D:/filter-root-a"), second = treeFilterFor("D:/filter-root-b");
  first.set({ open: true, text: "Alpha" }); second.set({ open: true, text: "Beta" });
  let write: ReturnType<typeof useTreeFilterState>[1];
  function Probe({ path }: { path: string }) { const [, setText] = useTreeFilterState(path); write = setText; return null; }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  dispose = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => root.render(<Probe path="D:/filter-root-a" />)); const original = write!;
  await act(async () => first.set({ text: "Alpha2" })); expect(write!).toBe(original);
  await act(async () => root.render(<Probe path="D:/filter-root-b" />));
  await act(async () => write!(""));
  expect(first.get().text).toBe("Alpha2"); expect(second.get().text).toBe("");
});
