// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePageMotion } from "./WorkspacePageMotion";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
const originalTransition = Object.getOwnPropertyDescriptor(document, "startViewTransition");
const animation = { finished: Promise.resolve(), cancel: vi.fn() };
const animate = vi.fn(() => animation);
let host: HTMLDivElement;
let root: Root;
function Page({ page }: { page: string }) {
  const target = useRef<HTMLDivElement>(null);
  return <><div ref={target}><textarea defaultValue="draft" /></div><WorkspacePageMotion page={page} target={target} /></>;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: undefined });
  document.documentElement.style.setProperty("--dur-page", "170ms");
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
  document.documentElement.style.removeProperty("--dur-page");
  document.documentElement.style.removeProperty("--ease");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("真实内容框的页面淡入", () => {
  it("旧 WebView 切页只改变透明度，取消旧动画并保留编辑节点和草稿", () => {
    act(() => root.render(<Page page="files" />));
    const input = host.querySelector("textarea")!;
    input.value = "unsaved code";
    expect(animate).toHaveBeenCalledWith([{ opacity: .45 }, { opacity: 1 }], { duration: 170, easing: "ease-out" });
    act(() => root.render(<Page page="logs" />));
    expect(animation.cancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("unsaved code");
  });
  it("已有 ViewTransition 时不重复启动回退动画", () => {
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: vi.fn() });
    act(() => root.render(<Page page="db" />));
    expect(animate).not.toHaveBeenCalled();
  });
  it("减少动态效果时保留内容，跳过淡入", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    act(() => root.render(<Page page="files" />));
    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")?.value).toBe("draft");
  });
});
