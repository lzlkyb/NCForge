// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useAutoAnimateRM } from "./useAutoAnimateRM";
import { applyMotionPreference } from "../lib/motionPreference";
import { ViewActivityContext } from "../lib/viewActivity";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, y: number, frameId: number;
const frames = new Map<number, FrameRequestCallback>();
const cancel = vi.fn(), disconnect = vi.fn();
const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ finished: new Promise(() => {}), cancel }));
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
function Stack({ extra = false }: { extra?: boolean }) {
  const ref = useAutoAnimateRM();
  return <div ref={ref}><div data-row="a">A</div>{extra && <div data-row="b">B</div>}</div>;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); y = 100; frameId = 0; frames.clear();
  delete document.documentElement.dataset.motion;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect = disconnect; });
  Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    return { top: this.dataset.row === "a" ? y : 100, left: 0, width: 100, height: 40 } as DOMRect;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  delete document.documentElement.dataset.motion;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function paint() {
  await act(async () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(performance.now()); } });
}

it("animates only moved existing rows after a mutation, with no idle timers or frame loop", async () => {
  await act(async () => root.render(<Stack />));
  expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  y = 60;
  await act(async () => root.render(<Stack extra />));
  expect(frames.size).toBe(1);
  await paint();
  expect(animate).toHaveBeenCalledOnce();
  expect(animate.mock.calls[0]?.[0]).toEqual([{ translate: "0px 40px" }, { translate: "0px 0px" }]);
  expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  await act(async () => applyMotionPreference("reduce"));
  expect(cancel).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalledOnce();
});

it("never initializes motion when reduced or hidden, and hiding cancels a queued frame", async () => {
  const view = (active: boolean, extra = false) => <ViewActivityContext.Provider value={active}><Stack extra={extra} /></ViewActivityContext.Provider>;
  await act(async () => root.render(view(false)));
  expect(frames.size).toBe(0); expect(animate).not.toHaveBeenCalled();
  await act(async () => root.render(view(true)));
  y = 60;
  await act(async () => root.render(view(true, true)));
  expect(frames.size).toBe(1);
  await act(async () => root.render(view(false, true)));
  expect(frames.size).toBe(0); expect(animate).not.toHaveBeenCalled();
  await act(async () => applyMotionPreference("reduce"));
  await act(async () => root.render(view(true, true)));
  expect(animate).not.toHaveBeenCalled();
});

it("scrolling before a list mutation never animates existing rows back to their old scroll position", async () => {
  await act(async () => root.render(<Stack />));
  (host.firstElementChild as HTMLElement).scrollTop = 20;
  y = 80;
  await act(async () => root.render(<Stack extra />));
  await paint();
  expect(animate).not.toHaveBeenCalled();
});
