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
it("写回按钮不需要先展开复核", async () => {
 const host = document.createElement("div"); const root = createRoot(host);
 await act(async () => root.render(<TableEditTools changed={1} changedCells={1} added={0} deleted={0} editable saving={false} preview={false} onAdd={() => {}} onUndo={() => {}} onTogglePreview={() => {}} onSave={() => {}} />));
 const save = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("写回"))!;
 expect(save.disabled).toBe(false);
 await act(async () => root.unmount());
});
it("Tab / Enter 提交时按方向移动，Shift+Tab 反向；Shift+Enter 打开大文本编辑框", async () => {
 const host = document.createElement("div"); const root = createRoot(host);
 const move = vi.fn(), expand = vi.fn();
 await act(async () => root.render(<GridCellEditor id="t" colIndex={1} style={{}} value="v" changed={false} selected={{}} onChange={() => {}} onCommit={() => {}} onCancel={() => {}} onCommitMove={move} onExpand={expand} />));
 const input = host.querySelector("input")!;
 const press = async (key: string, opts: { shiftKey?: boolean; altKey?: boolean } = {}) => { await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key, ...opts, bubbles: true })); }); };
 await press("Enter"); expect(move).toHaveBeenLastCalledWith(1, 0);
 await press("Tab"); expect(move).toHaveBeenLastCalledWith(0, 1);
 await press("Tab", { shiftKey: true }); expect(move).toHaveBeenLastCalledWith(0, -1);
 // Shift+Enter 不再上移：改成打开大文本编辑框（单元格里改长文本等于盲打），且不提交、不移动。
 await press("Enter", { shiftKey: true });
 expect(expand).toHaveBeenCalledOnce();
 expect(move).toHaveBeenLastCalledWith(0, -1);
 // Alt+Enter 与 F2 是备路（Shift+Enter 被输入法占了的键盘）。Alt+Enter 必须在 Enter
 // 分支里判：放到 else if 会被先截走，实际变成「提交并下移」——这条断言钉的就是这个。
 await press("Enter", { altKey: true });
 expect(expand).toHaveBeenCalledTimes(2);
 expect(move).toHaveBeenLastCalledWith(0, -1);
 await press("F2");
 expect(expand).toHaveBeenCalledTimes(3);
 expect(move).toHaveBeenLastCalledWith(0, -1);
 await act(async () => root.unmount());
});
