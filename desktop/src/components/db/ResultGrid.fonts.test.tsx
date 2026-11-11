// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { getFontRevision } from "../../lib/fonts";
import { ResultGrid } from "./ResultGrid";

vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
vi.mock("../../lib/resultView", async original => {
  const actual = await original<typeof import("../../lib/resultView")>();
  return { ...actual, initialWidths: () => [100 + getFontRevision() * 20, 100 + getFontRevision() * 20] };
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

it("字体加载后重新计算自动列宽，保留手调宽度、选区、滚动和编辑草稿", () => {
  const target = new EventTarget();
  Object.defineProperty(document, "fonts", { configurable: true, value: target });
  const scrollTo = vi.fn();
  HTMLElement.prototype.scrollTo = scrollTo;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  const columns = ["CODE", "NAME"].map(name => ({ name, type: "VARCHAR2", precision: 50, scale: 0 }));
  const rows = Array.from({ length: 100 }, (_, i) => [String(i), `名称 ${i}`]);
  const edited = vi.fn();
  try {
    act(() => root.render(<ResultGrid columns={columns} rows={rows} order={rows.map((_, i) => i)}
      visible={[0, 1]} frozen={[]} widthOverrides={{ NAME: 240 }} onWidths={() => {}} sort={null} onSort={() => {}}
      sel={{ r: 40, c: 1 }} selection={{ anchor: { r: 40, c: 1 }, end: { r: 40, c: 1 } }} onSel={() => {}}
      edit={{ canEdit: () => true, changed: new Map(), onEdit: edited }} />));
    const grid = host.querySelector<HTMLDivElement>('[role="grid"]')!;
    act(() => { grid.scrollTop = 40 * 26; grid.dispatchEvent(new Event("scroll", { bubbles: true })); });
    act(() => grid.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })));
    const input = host.querySelector<HTMLInputElement>(".dbx-gedit")!;
    expect(input.value).toBe("名称 40");
    const headerWidths = () => [...host.querySelectorAll<HTMLElement>(".dbx-gh")].map(cell => cell.style.width);
    expect(headerWidths()).toContain("100px");
    expect(headerWidths()).toContain("240px");
    act(() => target.dispatchEvent(new Event("loadingdone")));
    expect(headerWidths()).toContain("120px");
    expect(headerWidths()).toContain("240px");
    expect(grid.scrollTop).toBe(40 * 26);
    expect(host.querySelector(".dbx-gedit")).toBe(input);
    expect(host.querySelector("#dbx-cell-40-1")?.getAttribute("aria-selected")).toBe("true");
    expect(scrollTo).not.toHaveBeenCalled();
    expect(edited).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); host.remove(); delete (document as unknown as { fonts?: FontFaceSet }).fonts; }
});
