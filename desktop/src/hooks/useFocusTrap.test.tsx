// @vitest-environment jsdom
/**
 * 焦点陷阱的三条纪律：进来时有焦点、Tab 不出界、出去时焦点归还。
 *
 * 🔴 这个文件守的两个回归点都有过真实后果：
 * 1. `focusables()` 原本在每个按键上都跑一遍（DOM 查询 + 量布局），弹窗控件多时
 *    连方向键都要白扫——只有 Tab 需要知道环里有哪些元素；
 * 2. 归还焦点时直接 `prev?.focus?.()`：打开弹窗的那个按钮可能已经滚出视口
 *    （长列表里点开一个操作菜单），焦点回到一个看不见的地方，后续 Tab 从
 *    屏幕外开始，键盘用户完全迷失。
 */
import { useRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFocusTrap } from "./useFocusTrap";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const realRects = Element.prototype.getClientRects;

/** jsdom 不做布局，`getClientRects()` 永远为空——陷阱的可见性过滤器会把所有元素滤掉。 */
beforeEach(() => {
  Element.prototype.getClientRects = (() => [{ width: 8, height: 8 }]) as unknown as Element["getClientRects"];
});

afterEach(async () => {
  Element.prototype.getClientRects = realRects;
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

/**
 * 陷阱里放三个按钮：第一个进环，第二个 `tabindex=-1`（不该进环），第三个正常。
 * `tabindex=-1` 的按钮仍匹配 `button` 选择器，只能靠 `tabIndex >= 0` 挡掉——
 * 漏了它，Shift+Tab 从环首会落到这个编程焦点元素上，视觉上就是「焦点跳去了
 * 一个点不着的地方」。
 */
function Probe({ onEscape }: { onEscape?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onEscape });
  return (
    <div ref={ref}>
      <button type="button">一</button>
      <button type="button" tabIndex={-1}>二</button>
      <button type="button">三</button>
    </div>
  );
}

const mount = async (onEscape?: () => void) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe onEscape={onEscape} />));
  return container;
};

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));

const key = async (target: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => target.dispatchEvent(event));
  return event;
};

describe("useFocusTrap", () => {
  it("挂载即把焦点放进环里，且 tabindex=-1 的不算环成员", async () => {
    await mount();
    const [first, negative, last] = buttons();
    expect(document.activeElement).toBe(first);
    expect(negative.tabIndex).toBe(-1);
    // 从环尾按 Tab：回到第一个，而不是落到被踢出环的第二个上
    last.focus();
    await key(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("Shift+Tab 从环首绕到环尾，同样跳过 tabindex=-1", async () => {
    await mount();
    const [, negative, last] = buttons();
    const first = buttons()[0];
    first.focus();
    await key(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(document.activeElement).not.toBe(negative);
  });

  it("只有 Tab 才扫焦点环：方向键与打字不再白扫 DOM", async () => {
    await mount();
    const last = buttons()[2];
    // 计数器装在元素自身上：挂载时那一次 focusables() 发生在装之前，基线就是 0
    const spy = vi.spyOn(last, "getClientRects");
    expect(spy).not.toHaveBeenCalled();
    // 五个非 Tab 按键：一次都不该再量布局
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "a"]) {
      await key(last, { key: k });
    }
    expect(spy).not.toHaveBeenCalled();
    // Tab 需要知道环里有哪些元素，允许扫一次；顺带验一下环尾绕回环首
    last.focus();
    await key(last, { key: "Tab" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it("data-autofocus 的元素优先拿初始焦点，而不是环里第一个", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const ProbeAuto = () => {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref);
      return (
        <div ref={ref}>
          <button type="button">确定</button>
          <button type="button" data-autofocus>取消</button>
        </div>
      );
    };
    await act(async () => root!.render(<ProbeAuto />));
    // 高危确认框的第一个往往是复选框或「不再询问」，焦点该钉在「取消」上
    expect(document.activeElement?.textContent).toBe("取消");
    expect(container.querySelector("button")?.textContent).toBe("确定");
  });

  it("Esc 交给调用方，且不继续往外层弹窗穿透", async () => {
    const onEscape = vi.fn();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    await mount(onEscape);
    await key(buttons()[0], { key: "Escape" });
    window.removeEventListener("keydown", outer);
    expect(onEscape).toHaveBeenCalledOnce();
    // 嵌套弹窗：确认框的 Esc 只该关自己，不能把外面的模态一起关掉
    expect(outer).not.toHaveBeenCalled();
  });

  it("IME 组词中的 Esc 属于输入法，不触发关闭", async () => {
    const onEscape = vi.fn();
    await mount(onEscape);
    await key(buttons()[0], { key: "Escape", isComposing: true });
    expect(onEscape).not.toHaveBeenCalled();
    // keyCode 229 是老浏览器 / 部分输入法上报组词的唯一信号
    await key(buttons()[0], { key: "Escape", keyCode: 229 });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("卸载时把焦点还给打开前的元素", async () => {
    const opener = document.createElement("button");
    opener.textContent = "打开";
    document.body.append(opener);
    opener.focus();
    await mount();
    expect(document.activeElement).not.toBe(opener);
    await act(async () => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("打开前的元素已滚出视口：还焦点时把它滚回可见处", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    // 长列表里点开一个操作菜单：触发器在视口上方 400px，focus() 之后浏览器不会自动滚过去
    opener.getBoundingClientRect = () => ({ top: -400, bottom: -380, left: 0, right: 80 }) as DOMRect;
    const scroll = vi.fn();
    opener.scrollIntoView = scroll;
    await mount();
    await act(async () => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    opener.remove();
  });

  it("打开前的元素在视口内就不滚：不该为每次关弹窗都跳一下页面", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    opener.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 0, right: 80 }) as DOMRect;
    const scroll = vi.fn();
    opener.scrollIntoView = scroll;
    await mount();
    await act(async () => root?.unmount());
    root = null;
    expect(scroll).not.toHaveBeenCalled();
    opener.remove();
  });

  it("抽屉动作已把焦点交给新露出的内容时不抢回来", async () => {
    // 关抽屉时若顺手 focus 了别处（真正想给用户看的东西），陷阱不能把它拽回打开者
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const container = await mount();
    const revealed = document.createElement("button");
    revealed.textContent = "新内容";
    container.append(revealed);
    revealed.focus();
    await act(async () => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(revealed);
    opener.remove();
    revealed.remove();
  });

  it("enabled 为 false 时不抢焦点，翻成 true 才进环", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const Gated = ({ enabled }: { enabled: boolean }) => {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, { enabled });
      return <div ref={ref}><button type="button">环内</button></div>;
    };
    await act(async () => root!.render(<Gated enabled={false} />));
    expect(document.activeElement).toBe(document.body);
    await act(async () => root!.render(<Gated enabled />));
    expect(document.activeElement?.textContent).toBe("环内");
  });
});
