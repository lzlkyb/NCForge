// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskMenu } from "./TaskMenu";

const h = vi.hoisted(() => ({ task: vi.fn(), compile: vi.fn() }));
vi.mock("../../lib/ncTasks", () => ({ STEP_SHORT: { compileActive: "编译当前", deploy: "投送" }, runTask: h.task, listTasks: () => [{ id: "builtin.compileActive", name: "编译当前模块", steps: ["compileActive"] }, { id: "custom", name: "自定义投送", steps: ["deploy"] }] }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { h.task.mockClear(); h.compile.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root.render(<TaskMenu root="C:/w" compiling={false} compile={{ module: "ic", reason: null, run: h.compile }} />)); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });
it("主按钮和菜单中的当前模块共用原编译入口；其他任务仍执行原任务流程", async () => {
  act(() => host.querySelector<HTMLButtonElement>(".wb-compile-primary")!.click());
  expect(h.compile).toHaveBeenCalledTimes(1);
  for (const name of ["编译当前模块", "自定义投送"]) {
    await act(async () => host.querySelector<HTMLButtonElement>(".wb-compile-dropdown")!.click());
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent?.startsWith(name))!;
    await act(async () => item.click());
  }
  expect(h.compile).toHaveBeenCalledTimes(2); expect(h.task).toHaveBeenCalledTimes(1);
});
it("键盘菜单关闭后焦点回到下拉，编译按钮仍是一键动作", async () => {
  const dropdown = host.querySelector<HTMLButtonElement>(".wb-compile-dropdown")!;
  act(() => { dropdown.focus(); dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  await act(async () => {});
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.activeElement).toBe(dropdown); expect(h.compile).not.toHaveBeenCalled();
});
