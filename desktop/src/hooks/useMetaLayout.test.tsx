// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useMetaLayout } from "./useMetaLayout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
it("停靠 portal 延迟挂载后接上尺寸监听，按实际可用宽高切换面板", () => {
  let width = 960, height = 600;
  let resized!: () => void;
  const disconnect = vi.fn(), observe = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height, x: 0, y: 0, top: 0, left: 0, bottom: height, right: width, toJSON: () => ({}) }));
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  let layout!: ReturnType<typeof useMetaLayout>;
  function Harness({ attached }: { attached: boolean }) { layout = useMetaLayout(); return attached ? <div ref={layout.ref} /> : null; }
  act(() => root.render(<Harness attached={false} />));
  expect(observe).not.toHaveBeenCalled();
  act(() => root.render(<Harness attached />));
  expect(observe).toHaveBeenCalledTimes(1);
  expect(layout.resourceDrawer).toBe(true); expect(layout.inspectorDrawer).toBe(true); expect(layout.compact).toBe(true);
  act(() => { width = 1280; height = 900; resized(); });
  expect(layout.resourceDrawer).toBe(false); expect(layout.inspectorDrawer).toBe(true); expect(layout.compact).toBe(false);
  act(() => { width = 1600; resized(); });
  expect(layout.inspectorDrawer).toBe(false);
  act(() => root.unmount()); host.remove();
  expect(disconnect).toHaveBeenCalled();
});
