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
function Page({ page, ready = true }: { page: string; ready?: boolean }) {
  const target = useRef<HTMLDivElement>(null);
  return <><div ref={target}>
    <div className="wb-code-surface" hidden={page !== "files"}><div className="wb-tabs">Source.java</div><textarea defaultValue="draft" /></div>
    <div className="wb-document-surface" hidden={page === "files"}>
      {!ready ? <div data-workspace-skeleton={page} data-loading-region="document" />
        : page === "db" ? <><div className="dbx-doctabs" /><div className="dbx-editor" /></>
        : <div className="lg-page" />}
    </div>
  </div><WorkspacePageMotion page={page} target={target} /></>;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: undefined });
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  if (originalTransition) Object.defineProperty(document, "startViewTransition", originalTransition);
  else Reflect.deleteProperty(document, "startViewTransition");
  delete document.documentElement.dataset.motion;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("工作台页面过渡", () => {
  it("应用内减少动效会中断当前过渡并保留草稿", () => {
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
  it("连续切页只淡入新区域，编辑器立即可读并保留草稿", () => {
    act(() => root.render(<Page page="files" />));
    const input = host.querySelector("textarea")!;
    input.value = "unsaved code";
    expect(animate).not.toHaveBeenCalled();
    act(() => root.render(<Page page="logs" />));
    expect(animate).toHaveBeenCalledWith([{ opacity: .86 }, { opacity: 1 }], { duration: 140, easing: expect.any(String) });
    expect(animate.mock.contexts[0]).toBe(host.querySelector(".lg-page"));
    act(() => root.render(<Page page="db" />));
    expect(animation.cancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.contexts[1]).toBe(host.querySelector(".dbx-doctabs"));
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
    act(() => root.render(<Page page="db" />));
    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")?.value).toBe("draft");
  });
  it("首次进入等待停靠区就绪，且每次导航只播放一次", async () => {
    await act(async () => root.render(<Page page="files" />));
    await act(async () => root.render(<Page page="db" ready={false} />));
    expect(animate).not.toHaveBeenCalled();
    await act(async () => root.render(<Page page="db" />));
    expect(animate).toHaveBeenCalledOnce();
    await act(async () => { host.querySelector('.dbx-editor')!.append('result'); });
    expect(animate).toHaveBeenCalledOnce();
  });
});
