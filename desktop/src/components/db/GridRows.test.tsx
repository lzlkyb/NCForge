// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GridRows } from "./GridRows";

let host: HTMLDivElement, root: Root, props: ComponentProps<typeof GridRows>;
beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const rows = Array.from({ length: 20 }, (_, i) => ["value-" + i]);
  props = {
    rows, order: rows.map((_, i) => i), first: 0, last: 5,
    layout: { heights: rows.map(() => 26), offsetAt: i => i * 26 },
    rowH: 26, headH: 40, total: 140, rnW: 40,
    viewport: [{ column: 0, index: 0, width: 100, frozen: false, sticky: 40, left: 40 }],
    visible: [0], bounds: null, sel: null, editing: null, textOpen: false, numeric: [false], wrap: false,
    valueAt: (r, c) => rows[r][c], cellStyle: () => ({ width: 100, position: "absolute", left: 40 }),
    codec: { encoded: () => false, active: () => false, value: () => null, title: () => undefined, text: vi.fn(v => String(v)) },
    onSel: vi.fn(), startEdit: vi.fn(), boxRef: { current: host },
    onCellEditor: { onChange: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn(), onCommitMove: vi.fn(), onExpand: vi.fn() },
  };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = () => act(() => root.render(<GridRows {...props} />));
it("reuses overlapping rows while rendering only the entering row", () => {
  render(); expect(props.codec.text).toHaveBeenCalledTimes(5);
  props = { ...props, first: 1, last: 6 }; render();
  expect(props.codec.text).toHaveBeenCalledTimes(6);
  expect(host.querySelectorAll(".dbx-grow")).toHaveLength(5);
  expect(host.querySelector('[aria-rowindex="7"]')?.textContent).toContain("value-5");
});
it("reused cells invoke the latest selection callback", () => {
  render(); const old = props.onSel, next = vi.fn();
  props = { ...props, onSel: next }; render();
  act(() => host.querySelector('[role="gridcell"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(old).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledWith({ r: 0, c: 0 }, false);
});
it("reuses retained columns and updates cells when their geometry changes", () => {
  const rows = props.rows.map(row => [row[0], "second", "third"]);
  const columns = [0, 1, 2].map(column => ({ column, index: column, width: 100, frozen: false, sticky: 40, left: 40 + column * 100 }));
  props = { ...props, rows, valueAt: (r, c) => rows[r][c], visible: [0, 1, 2], numeric: [false, false, false],
    total: 340, viewport: columns.slice(0, 2), cellStyle: c => ({ width: columns[c].width, position: "absolute", left: columns[c].left }) };
  render(); expect(props.codec.text).toHaveBeenCalledTimes(10);
  props = { ...props, viewport: columns.slice(1) }; render();
  expect(props.codec.text).toHaveBeenCalledTimes(15);
  columns[1] = { ...columns[1], width: 140 };
  props = { ...props, viewport: columns.slice(1) }; render();
  expect(props.codec.text).toHaveBeenCalledTimes(20);
  expect((host.querySelector('#dbx-cell-0-1') as HTMLElement).style.width).toBe("140px");
});
it("new data and selection refresh retained cells without losing absolute row indexes", () => {
  render(); const rows = props.rows.map(row => row.map(v => v + "-new"));
  props = { ...props, rows, valueAt: (r, c) => rows[r][c], sel: { r: 2, c: 0 } }; render();
  const cell = host.querySelector('#dbx-cell-2-0')!;
  expect(cell.textContent).toBe("value-2-new");
  expect(cell.hasAttribute("data-active-cell")).toBe(true);
  expect(cell.closest('[role="row"]')?.getAttribute("aria-rowindex")).toBe("4");
});
