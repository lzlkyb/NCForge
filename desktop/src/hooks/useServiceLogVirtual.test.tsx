// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServiceLogRow } from "../lib/serviceLogRows";
import { useServiceLogVirtual } from "./useServiceLogVirtual";

let root: Root, host: HTMLDivElement, body: { current: HTMLDivElement }, rows: ServiceLogRow[];
let virtual: ReturnType<typeof useServiceLogVirtual>;
const frames = new Map<number, FrameRequestCallback>();
let sequence = 0;
const row = (id: number): ServiceLogRow => ({ key: String(id), kind: "line", line: { id, time: "", thread: "", logger: "", text: "line " + id, stack: false, level: "info" } });
function Probe({ follow = false, visible = true }: { follow?: boolean; visible?: boolean }) {
  virtual = useServiceLogVirtual(rows, body, follow, visible, false, 13, 0); return null;
}
beforeEach(() => {
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); body = { current: host };
  Object.defineProperties(host, { clientHeight: { value: 100 }, clientWidth: { value: 400 } });
  rows = Array.from({ length: 4000 }, (_, i) => row(i));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (props = {}) => act(() => root.render(<Probe {...props} />));
const paint = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)); });
const scroll = (top: number) => { host.scrollTop = top; virtual.onScroll(); };
it("coalesces scroll bursts and retains a covered window while native pixels move", () => {
  render(); const first = virtual.start, end = virtual.end;
  scroll(30); scroll(60); expect(frames.size).toBe(1); paint();
  expect(host.scrollTop).toBe(60); expect(virtual.start).toBe(first); expect(virtual.end).toBe(end);
  scroll(2500); paint();
  expect(virtual.start).toBeLessThan(2500 / 23); expect(virtual.end * 23).toBeGreaterThan(2600);
  expect(virtual.end - virtual.start).toBeLessThan(30);
});
it("keeps the reading anchor when earlier history is prepended", () => {
  render(); scroll(2500); paint();
  rows = [...Array.from({ length: 20 }, (_, i) => row(i - 20)), ...rows]; render();
  expect(host.scrollTop).toBe(2500 + 20 * 23);
});
it("jumps immediately, follows the tail and cancels hidden viewport work", () => {
  render(); act(() => virtual.jumpTo("3500"));
  expect(host.scrollTop).toBe(3500 * 23); expect(virtual.start).toBeLessThanOrEqual(3500); expect(virtual.end).toBeGreaterThan(3500);
  render({ follow: true }); expect(host.scrollTop).toBe(4000 * 23 - 100);
  scroll(500); expect(frames.size).toBe(1); render({ visible: false }); expect(frames.size).toBe(0);
});
