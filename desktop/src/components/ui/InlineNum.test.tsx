// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineNum } from "./InlineNum";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 防抖生命周期的三道锁（2026-10-27 修复的回归网）：
//   1. 到点只保存一次，blur 不补第二刀（旧实现 ref 残留旧定时器 id → 双保存）；
//   2. blur 在窗口内 = 立即 flush，且不会再有第二次；
//   3. 卸载即销定时器——不对已卸载组件触发父组件 setState。
let root: Root;
let container: HTMLDivElement;
const onSave = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

async function mount() {
  await act(async () => root.render(<InlineNum value={5} saved={false} unit="秒" onSave={onSave} />));
}
// 查询根容器而不是 document：createRoot 的容器是游离节点（不像 portal 会挂
// document.body），document.querySelector 找不到里面的 input。
const input = () => container.querySelector("input") as HTMLInputElement;

/** 走原生 setter 绕开 React 的 value tracker，再派发 input 事件触发 onChange。 */
async function typeInto(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("InlineNum 防抖生命周期", () => {
  it("输入 800ms 后只保存一次；随后 blur 不补第二刀", async () => {
    await mount();
    await typeInto("9");
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(9);
    // 定时器到点后 ref 必须已清空：否则 blur 会 clearTimeout（对已触发定时器是
    // no-op）+ 再 onSave 一次——同一值保存两遍。
    await act(async () => { input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("blur 在防抖窗口内立即落保存，且不会有第二次", async () => {
    await mount();
    await typeInto("7");
    await act(async () => { input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(7);
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("卸载时清掉未触发的定时器，不对已卸载组件保存", async () => {
    await mount();
    await typeInto("3");
    await act(async () => root.unmount());
    await act(async () => { vi.advanceTimersByTime(800); });
    expect(onSave).not.toHaveBeenCalled();
  });
});
