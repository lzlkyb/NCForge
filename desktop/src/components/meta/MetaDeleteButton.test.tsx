// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaDeleteButton } from "./MetaDeleteButton";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mocks.invoke.mockReset();
  // 确认框默认会等 140ms 退场动画再执行动作；测试里按「减少动画」跑，点击即确认。
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const buttons = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === text);

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("确认后提交 deleteNode，成功后刷新", async () => {
  mocks.invoke.mockResolvedValue({ path: "x", backup: "b", shaBefore: "a", shaAfter: "c", diff: "", changed: true });
  const done = vi.fn();
  await act(async () =>
    root.render(<MetaDeleteButton path="D:/w/a.bmf" sha="sha" id="a1" what="字段 pk" onDone={done} />),
  );

  await act(async () => buttons("删除")[0].click());
  expect(document.body.textContent).toContain("删除字段 pk？");
  // 确认框里的删除是最后一个同名按钮
  await act(async () => buttons("删除")[buttons("删除").length - 1].click());
  await flush();

  const call = mocks.invoke.mock.calls.find(([cmd]) => cmd === "bmf_edit_save")!;
  expect((call[1] as { ops: unknown[] }).ops).toEqual([{ op: "deleteNode", id: "a1" }]);
  expect(done).toHaveBeenCalled();
});

it("后端拒绝（仍被引用）时展示内联原因而不是静默失败", async () => {
  mocks.invoke.mockRejectedValue(new Error("字段 pk 是实体主键，先改主键再删"));
  await act(async () =>
    root.render(<MetaDeleteButton path="D:/w/a.bmf" sha="sha" id="a1" what="字段 pk" onDone={() => {}} />),
  );
  await act(async () => buttons("删除")[0].click());
  await act(async () => buttons("删除")[buttons("删除").length - 1].click());
  await flush();

  expect(document.body.textContent).toContain("没有删除");
  expect(document.body.textContent).toContain("先改主键再删");
});
