// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectionIndicator } from "./SelectionIndicator";
import { applyMotionPreference } from "../../lib/motionPreference";

vi.mock("../../lib/appVisibility", () => ({ useAppHidden: () => false }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, visualTop: number | undefined;
const animations: { cancel: ReturnType<typeof vi.fn>; finished: Promise<void> }[] = [];
const nativeAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
const animate = vi.fn((_frames: Keyframe[] | PropertyIndexedKeyframes, _options?: number | KeyframeAnimationOptions) => { const animation = { cancel: vi.fn(), finished: new Promise<void>(() => {}) }; animations.push(animation); return animation; });
function Probe({ selected }: { selected: string }) {
  const container = useRef<HTMLDivElement>(null);
  return <div ref={container} data-host><textarea defaultValue="draft" /><nav>{["A", "B", "C"].map((key, i) => <button key={key} data-top={i * 40} data-selected={selected === key || undefined}>{key}</button>)}</nav>
    <SelectionIndicator container={container} value={selected} selector="[data-selected]" /></div>;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  animations.length = 0; animate.mockClear(); visualTop = undefined;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const indicator = this.classList.contains("ui-selection-indicator");
    const top = indicator ? visualTop ?? (Number.parseFloat(this.style.top) || 0) : Number(this.dataset.top ?? 0);
    return { left: 0, top, right: 100, bottom: top + 30, width: 100, height: 30, x: 0, y: top, toJSON() {} } as DOMRect;
  });
  delete document.documentElement.dataset.motion;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.motion;
  if (nativeAnimate) Object.defineProperty(HTMLElement.prototype, "animate", nativeAnimate); else Reflect.deleteProperty(HTMLElement.prototype, "animate"); });

it("positions immediately, animates only its marker and starts reversals from the current visual position", () => {
  act(() => root.render(<Probe selected="A" />));
  const input = host.querySelector("textarea")!; input.focus();
  expect(animate).not.toHaveBeenCalled();
  act(() => root.render(<Probe selected="B" />));
  act(() => vi.advanceTimersByTime(16));
  expect(animate).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(input);
  visualTop = 18;
  act(() => root.render(<Probe selected="A" />));
  act(() => vi.advanceTimersByTime(16));
  expect(animations[0].cancel).toHaveBeenCalledOnce();
  expect(animate.mock.calls[1]?.[0]).toEqual([{ transform: "translate(0px,18px) scale(1,1)", opacity: .8 }, { transform: "none", opacity: 1 }]);
  expect(host.querySelector("textarea")).toBe(input);
});

it("snaps in reduced motion, releases stale animation and removes a missing selection", () => {
  act(() => root.render(<Probe selected="A" />));
  act(() => root.render(<Probe selected="B" />));
  act(() => vi.advanceTimersByTime(16));
  act(() => applyMotionPreference("reduce"));
  expect(animations[0].cancel).toHaveBeenCalled();
  expect(animate).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLElement>(".ui-selection-indicator")?.style.top).toBe("40px");
  act(() => root.render(<Probe selected="none" />));
  act(() => vi.advanceTimersByTime(16));
  expect(host.querySelector<HTMLElement>("[data-host]")?.dataset.motionSelectionReady).toBeUndefined();
  expect(host.querySelector<HTMLElement>(".ui-selection-indicator")?.hidden).toBe(true);
});

it("coalesces navigation within a frame and cancels a pending measurement on unmount", () => {
  act(() => root.render(<Probe selected="A" />));
  act(() => root.render(<Probe selected="B" />));
  act(() => root.render(<Probe selected="C" />));
  expect(animate).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(16));
  expect(animate).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLElement>(".ui-selection-indicator")?.style.top).toBe("80px");
  act(() => root.render(<Probe selected="B" />));
  act(() => root.render(null));
  act(() => vi.advanceTimersByTime(16));
  expect(animate).toHaveBeenCalledOnce();
});
