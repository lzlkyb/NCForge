// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useGridRowLayout } from "./useGridRowLayout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const rows = [["abcdefghij"]], widths = [60], order = [0];
const columns = [{ name: "TEXT", type: "VARCHAR2", precision: 100, scale: 0 }];

it("字体加载改变字宽时更新行高；拖列宽期间保持旧几何，松手再校准", () => {
  const target = new EventTarget();
  Object.defineProperty(document, "fonts", { configurable: true, value: target });
  let perChar = 6;
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "",
    measureText: (text: string) => ({ width: text.length * perChar }),
  } as unknown as CanvasRenderingContext2D);
  function Probe({ frozen = false }: { frozen?: boolean }) {
    const layout = useGridRowLayout({ rows, columns, widths, order, wrap: true, rowH: 26, frozen });
    return <output>{layout.total}</output>;
  }
  const host = document.createElement("div"), root = createRoot(host);
  const total = () => Number(host.querySelector("output")!.textContent);
  try {
    act(() => root.render(<Probe />));
    const fallback = total();
    perChar = 9;
    act(() => target.dispatchEvent(new Event("loadingdone")));
    const loaded = total();
    expect(loaded).toBeGreaterThan(fallback);
    act(() => root.render(<Probe frozen />));
    perChar = 12;
    act(() => target.dispatchEvent(new Event("loadingdone")));
    expect(total()).toBe(loaded);
    act(() => root.render(<Probe />));
    expect(total()).toBeGreaterThan(loaded);
  } finally {
    act(() => root.unmount());
    vi.restoreAllMocks();
    delete (document as unknown as { fonts?: FontFaceSet }).fonts;
  }
});
