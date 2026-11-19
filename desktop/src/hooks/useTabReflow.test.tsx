// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useTabReflow } from "./useTabReflow";
vi.mock("../lib/appVisibility", () => ({ useAppHidden: () => false }));
vi.mock("./usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => false }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nativeAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
afterEach(() => { vi.restoreAllMocks(); if (nativeAnimate) Object.defineProperty(HTMLElement.prototype, "animate", nativeAnimate); else Reflect.deleteProperty(HTMLElement.prototype, "animate"); });

it("animates retained labels on close, preserves document DOM and cancels frames on exit", () => {
  const running: { cancel: ReturnType<typeof vi.fn>; finished: Promise<void> }[] = [];
  const animate = vi.fn(() => { const animation = { cancel: vi.fn(), finished: new Promise<void>(() => {}) }; running.push(animation); return animation; });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = Number(this.dataset.index ?? 0) * 100;
    return { left, top: 0, right: left + 600, bottom: 30, width: 600, height: 30, x: left, y: 0, toJSON() {} } as DOMRect;
  });
  function Probe({ tabs }: { tabs: string[] }) {
    const container = useRef<HTMLDivElement>(null); useTabReflow(container, tabs.join("|"));
    return <><div ref={container}>{tabs.map((path, i) => <div key={path} role="tab" data-path={path} data-index={i}>{path}</div>)}</div><textarea defaultValue="draft" /></>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    act(() => root.render(<Probe tabs={["A", "B", "C"]} />)); const input = host.querySelector("textarea");
    expect(animate).not.toHaveBeenCalled();
    act(() => root.render(<Probe tabs={["B", "C"]} />));
    expect(animate).toHaveBeenCalledTimes(2); expect(host.querySelector("textarea")).toBe(input);
    act(() => root.unmount()); expect(running.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
  } finally { act(() => root.unmount()); host.remove(); }
});
