// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuItem } from "./Menu";
import { ViewActivityContext } from "../../lib/viewActivity";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const run = vi.fn();
const render = async (portal = true, active = true) => act(async () => root.render(<ViewActivityContext.Provider value={active}><Menu portal={portal} trigger={(open, toggle) => <button aria-expanded={open} onClick={toggle}>操作</button>}>{close => <><MenuItem label="文件" onClick={() => { run(); close(); }}/><MenuItem label="编辑" onClick={close}/></>}</Menu></ViewActivityContext.Provider>));
const click = async (element: Element) => act(async () => (element as HTMLButtonElement).click());
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("menus in scrollable SSH sidebar", () => {
  it("搜索输入保留Home/End与中文组词，方向键仍可进入菜单项", async () => {
    await act(async () => root.render(<Menu portal trigger={(open, toggle) => <button aria-expanded={open} onClick={toggle}>来源</button>}>
      {close => <><input aria-label="搜索来源" defaultValue="metadata" /><MenuItem label="metadata" onClick={close} /></>}
    </Menu>));
    await click(container.querySelector("button")!);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索来源"]')!; input.focus();
    for (const key of ["Home", "End"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => input.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false); expect(document.activeElement).toBe(input);
    }
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", isComposing: true, bubbles: true })));
    expect(document.activeElement).toBe(input);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("metadata");
  });
  it("浮层挂到 body；菜单内点击不会被外部点击处理器抢先关闭", async () => {
    await render(); await click(container.querySelector("button")!);
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.parentElement).toBe(document.body);
    const item = menu.querySelector("button")!;
    await act(async () => item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await click(item);
    expect(run).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("键盘可从触发器进入浮层；Esc 关闭并把焦点还给触发器", async () => {
    await render(); const trigger = container.querySelector("button")!;
    await click(trigger); trigger.focus();
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("文件");
    const last = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1];
    const scroll = vi.fn(); last.scrollIntoView = scroll;
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("编辑");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
  it.each(["resize", "scroll"])("%s 后关闭旧坐标浮层", async event => {
    await render(); await click(container.querySelector("button")!);
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("切离终端页时关闭浮层；原有普通菜单保持就地渲染", async () => {
    await render(); await click(container.querySelector("button")!); await render(true, false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await render(false); await click(container.querySelector("button")!);
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });
});

it("从键盘打开门户菜单后焦点进入菜单，Esc 返回触发器", async () => {
  await render();
  const trigger = container.querySelector("button")!;
  trigger.focus();
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  expect(document.activeElement?.textContent).toBe("文件");
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(trigger);
});

describe("键盘意图只在「按键打开」那一次有效", () => {
  it("鼠标点开菜单不会把焦点抢进菜单项", async () => {
    // 键盘意图（keyboardFocus）是「按键打开」那一次专属的。鼠标点开时它必须是空的，
    // 否则布局 effect 会把焦点拽到第一个菜单项上——用户根本没想用键盘，
    // 看到的却是「菜单开了，焦点莫名在第一项，回车直接触发它」。
    // 这里同时守住 onDown 的清零与 effect 的 `!keyboardFocus.current` 门闸。
    await render();
    const trigger = container.querySelector("button")!;
    trigger.focus();
    // 先按一次键盘打开再关掉：这一轮会把 ref 用掉并清空
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(document.activeElement?.textContent).toBe("文件");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(trigger);
    // 现在改用鼠标：先 mousedown（真实点击顺序，`.click()` 不发它）再 click
    await act(async () => trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await click(trigger);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.activeElement?.textContent).not.toBe("文件");
  });

  it("键盘打开后焦点确实落在意图指定的那一端", async () => {
    await render();
    const trigger = container.querySelector("button")!;
    trigger.focus();
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(document.activeElement?.textContent).toBe("文件");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    trigger.focus();
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
    expect(document.activeElement?.textContent).toBe("编辑");
  });
});

describe("异常关闭路径", () => {
  it("焦点被菜单外的内容拿走时关菜单（抽屉换了一批控件）", async () => {
    await render();
    await click(container.querySelector("button")!);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    const outside = document.createElement("button");
    outside.textContent = "别处";
    document.body.append(outside);
    await act(async () => outside.focus());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    outside.remove();
  });

  it("菜单内移动焦点不会把它关掉", async () => {
    await render();
    await click(container.querySelector("button")!);
    const item = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1];
    await act(async () => item.focus());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("选完项后焦点回触发器，菜单随即变 inert 也接得住键盘", async () => {
    await render();
    const trigger = container.querySelector("button")!;
    await click(trigger);
    const first = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0];
    await act(async () => first.focus());
    await click(first);
    expect(run).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
  });
});
