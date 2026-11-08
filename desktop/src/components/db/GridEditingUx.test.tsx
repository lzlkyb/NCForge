// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { GridCellEditor } from "./GridCellEditor";
import { TableEditTools } from "./TableEditTools";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("composition Enter and Escape do not commit or cancel an edit", async () => {
 const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
 const commit = vi.fn(), cancel = vi.fn();
 await act(async () => root.render(<GridCellEditor id="test" colIndex={1} style={{}} value="中文" changed={false} selected={{}} onChange={() => {}} onCommit={commit} onCancel={cancel} />));
 const input = host.querySelector("input")!;
 for (const key of ["Enter", "Escape"]) await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true })); });
 expect(commit).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
 await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
 expect(commit).toHaveBeenCalledOnce();
 await act(async () => root.unmount()); host.remove();
});
it("describes modified rows separately from cells", async () => {
 const host = document.createElement("div"); const root = createRoot(host);
 await act(async () => root.render(<TableEditTools changed={1} changedCells={3} added={0} deleted={0} editable saving={false} preview onAdd={() => {}} onUndo={() => {}} onTogglePreview={() => {}} onSave={() => {}} />));
 expect(host.textContent).toContain("修改 1 行（3 个单元格）"); expect(host.textContent).toContain("写回 1 行");
 await act(async () => root.unmount());
});
