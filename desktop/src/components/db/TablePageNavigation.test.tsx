// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock("../../lib/dbStore", () => ({ useConnRt: () => ({ status: "idle" }), columnsOf: vi.fn(), patchTab: mocks.patch }));
vi.mock("../../lib/dbRelations", () => ({ returnRelated: vi.fn() }));
vi.mock("./DbContextBar", () => ({ DbContextBar: () => null }));
vi.mock("./ImportDialog", () => ({ ImportDialog: () => null }));
vi.mock("./StructDiffDialog", () => ({ StructDiffDialog: () => null }));
vi.mock("./SourceView", () => ({ SourceView: () => null }));
vi.mock("./TableData", () => ({ TableData: () => null }));
vi.mock("./TableMoreActions", () => ({ TableMoreActions: () => null }));
vi.mock("./InsertExportDialog", () => ({ InsertExportDialog: () => null }));
import { TablePage } from "./TablePage";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("object tabs share one tab stop and arrow, Home, End navigation", async () => {
 const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
 const tab = { id: "t", connId: "c", table: "TEST", sub: "data", kind: "table" } as const;
 await act(async () => root.render(<TablePage tab={tab} />));
 const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
 expect(tabs.filter(t => t.tabIndex === 0)).toHaveLength(1);
 for (const [key, target] of [["ArrowRight", "struct"], ["End", "ddl"], ["Home", "data"]]) {
  await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  expect(mocks.patch).toHaveBeenLastCalledWith("t", { sub: target });
  expect(document.activeElement?.id).toBe(`dbx-object-t-${target}`);
 }
 expect(host.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(tabs[0].id);
 await act(async () => root.unmount()); host.remove();
});
