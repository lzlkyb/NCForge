// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePageMotion } from "./WorkspacePageMotion";
import { applyMotionPreference } from "../../lib/motionPreference";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
const originalTransition = Object.getOwnPropertyDescriptor(document, "startViewTransition");
const animation = { finished: Promise.resolve(), cancel: vi.fn() };
const animate = vi.fn(() => animation);
let host: HTMLDivElement;
let root: Root;
function Page({ page }: { page: string }) {
  const target = useRef<HTMLDivElement>(null);
  return <><div ref={target}><div className="wb-code-surface"><span className="wb-tab" data-active>Source.java</span><textarea defaultValue="draft" /></div></div><WorkspacePageMotion page={page} target={target} /></>;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: undefined });
  document.documentElement.style.setProperty("--dur-fast", "100ms");
  document.documentElement.style.setProperty("--ease", "ease-out");
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  if (originalTransition) Object.defineProperty(document, "startViewTransition", originalTransition);
  else Reflect.deleteProperty(document, "startViewTransition");
  document.documentElement.style.removeProperty("--dur-fast");
  document.documentElement.style.removeProperty("--ease");
  delete document.documentElement.dataset.motion;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("真实内容框的页面淡入", () => {
  it("应用内减少动效会中断旧引擎回退并保留草稿", () => {
    act(() => root.render(<Page page="files" />));
    const input = host.querySelector("textarea")!;
    input.value = "still editing";
    act(() => root.render(<Page page="db" />));
    act(() => applyMotionPreference("reduce"));
    expect(animation.cancel).toHaveBeenCalledOnce();
    act(() => root.render(<Page page="logs" />));
    expect(animate).toHaveBeenCalledOnce();
    expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("still editing");
  });
  it("旧 WebView 切页只改变透明度，取消旧动画并保留编辑节点和草稿", () => {
    act(() => root.render(<Page page="files" />));
    const input = host.querySelector("textarea")!;
    input.value = "unsaved code";
    expect(animate).not.toHaveBeenCalled();
    act(() => root.render(<Page page="logs" />));
    expect(animate).toHaveBeenCalledWith([{ opacity: .85 }, { opacity: 1 }], { duration: 100, easing: "ease-out" });
    expect(animate.mock.contexts[0]).toBe(host.querySelector(".wb-tab"));
    act(() => root.render(<Page page="db" />));
    expect(animation.cancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("unsaved code");
  });
  it("新引擎同样使用即时内容淡入，导航不请求截图", () => {
    const capture = vi.fn(); Object.defineProperty(document, "startViewTransition", { configurable: true, value: capture });
    act(() => root.render(<Page page="db" />));
    act(() => root.render(<Page page="logs" />));
    expect(animate).toHaveBeenCalledOnce();expect(capture).not.toHaveBeenCalled();
  });
  it("减少动态效果时保留内容，跳过淡入", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    act(() => root.render(<Page page="files" />));
    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")?.value).toBe("draft");
  });
});
