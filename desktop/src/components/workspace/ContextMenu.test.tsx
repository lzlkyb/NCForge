// @vitest-environment jsdom
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const onSelect = vi.fn(), onClose = vi.fn();

function Fixture() {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>文件树</button>
    <input aria-label="外部输入" />
    {open && <ContextMenu x={20} y={30} onClose={() => { onClose(); setOpen(false); }} items={[
      { label: "不可用", disabled: true, onSelect },
      { label: "打开", onSelect },
      { label: "复制路径", onSelect },
    ]} />}
  </>;
}

const openMenu = async () => {
  await act(async () => root.render(<StrictMode><Fixture /></StrictMode>));
  const trigger = container.querySelector("button")!;
  trigger.focus(); await act(async () => trigger.click());
  return trigger;
};
const key = async (value: string) => act(async () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
});

beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe("右键菜单焦点", () => {
  it("打开聚焦第一项，方向键跳过禁用项，Esc 归还触发前焦点", async () => {
    const trigger = await openMenu();
    expect(document.activeElement?.textContent).toBe("打开");
    await key("ArrowDown"); expect(document.activeElement?.textContent).toBe("复制路径");
    await key("Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onClose).toHaveBeenCalledOnce(); expect(onSelect).not.toHaveBeenCalled();
  });

  it("选择项先归还焦点，使后续弹窗可保存正确的返回位置", async () => {
    const trigger = await openMenu();
    onSelect.mockImplementation(() => expect(document.activeElement).toBe(trigger));
    const first = document.activeElement as HTMLButtonElement;
    await act(async () => first.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger); expect(onSelect).toHaveBeenCalledOnce();
  });

  it("外部按下关闭菜单时保留被点击输入的焦点", async () => {
    const trigger = await openMenu();
    const focus = vi.spyOn(trigger, "focus");
    const outside = container.querySelector("input")!;
    await act(async () => {
      outside.focus(); outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(outside); expect(focus).not.toHaveBeenCalled();
  });
});

describe("单选态菜单项", () => {
  /** 二进制列显示的三个档位就是这样用的：要能看出当前是哪一档。 */
  const renderChecked = async () => {
    await act(async () => root.render(<ContextMenu x={0} y={0} onClose={onClose} items={[
      { label: "自动识别", checked: true, onSelect },
      { label: "文本", checked: false, onSelect },
      { label: "原始 Hex", onSelect },
    ]} />));
    return Array.from(document.querySelectorAll('[role="menuitem"]'));
  };

  it("当前档位打勾且标为 current，未选中的项留出同样的空位", async () => {
    const [auto, text, raw] = await renderChecked();
    // 打勾靠图标占住 icon 位；未选中的项用等宽空槽占位，三档文字才不会左右错开。
    expect(auto.querySelector(".wb-ctx-icon")).not.toBeNull();
    expect(auto.getAttribute("aria-current")).toBe("true");
    expect(text.querySelector(".wb-ctx-icon")).toBeNull();
    expect(text.querySelector(".wb-ctx-slot")).not.toBeNull();
    expect(text.getAttribute("aria-current")).toBeNull();
    // 不传 checked 的项既不打勾也不算当前，但仍然占位（同一个菜单里的单选组要对齐）。
    expect(raw.getAttribute("aria-current")).toBeNull();
    expect(raw.querySelector(".wb-ctx-slot")).not.toBeNull();
  });

  it("没有单选组的普通菜单不额外插空槽", async () => {
    await act(async () => root.render(<ContextMenu x={0} y={0} onClose={onClose} items={[
      { label: "打开", onSelect },
    ]} />));
    expect(container.querySelector(".wb-ctx-slot")).toBeNull();  });
});
