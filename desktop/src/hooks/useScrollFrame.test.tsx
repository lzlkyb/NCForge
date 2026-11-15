// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useScrollFrame, useScrollIdle } from "./useScrollFrame";

let root: Root, host: HTMLDivElement, frame: ReturnType<typeof useScrollFrame>, idle: ReturnType<typeof useScrollIdle<undefined>>;
const callbacks = new Map<number, FrameRequestCallback>();
let sequence = 0;
function Probe({ callback }: { callback: () => void }) { frame = useScrollFrame(callback); idle = useScrollIdle(callback); return null; }
beforeEach(() => {
  vi.useFakeTimers(); callbacks.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const render = (callback: () => void) => act(() => root.render(<Probe callback={callback} />));
const paint = () => act(() => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(16)); });
it("coalesces an event burst and uses the latest callback without adding recurring frames", () => {
  const old = vi.fn(), current = vi.fn(); render(old);
  for (let i = 0; i < 100; i++) frame.schedule();
  expect(callbacks.size).toBe(1); render(current); paint();
  expect(old).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledTimes(1); expect(callbacks.size).toBe(0);
});
it("flushes keyboard navigation immediately and cancels stale frames on exit", () => {
  const callback = vi.fn(); render(callback); frame.schedule(); act(() => frame.flush());
  expect(callback).toHaveBeenCalledTimes(1); expect(callbacks.size).toBe(0);
  frame.schedule(); act(() => root.unmount()); expect(callbacks.size).toBe(0);
});
it("saves one offset after a gesture and flushes a pending offset on exit", () => {
  const callback = vi.fn(); render(callback);
  for (let i = 0; i < 10; i++) { idle.schedule(undefined); vi.advanceTimersByTime(20); }
  expect(callback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(150); expect(callback).toHaveBeenCalledTimes(1);
  idle.schedule(undefined); act(() => root.unmount()); expect(callback).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(500); expect(callback).toHaveBeenCalledTimes(2);
});
it("retains the scheduled document owner and can discard an obsolete position", () => {
  const old = vi.fn(), next = vi.fn(); render(old); idle.schedule(undefined);
  render(next); vi.advanceTimersByTime(150);
  expect(old).toHaveBeenCalledTimes(1); expect(next).not.toHaveBeenCalled();
  idle.schedule(undefined); idle.cancel(); vi.advanceTimersByTime(150);
  expect(next).not.toHaveBeenCalled();
});
