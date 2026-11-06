// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), text: vi.fn() }));
vi.mock("../../lib/editorStore", () => ({ getText: mocks.text }));
vi.mock("../../lib/workspace", () => ({ baseName: (path: string) => path.split(/[\\/]/).pop(), readFile: mocks.read }));
import { SourceContextPreview } from "./SourceContextPreview";
import { invalidateWorkspaceRequests } from "../../lib/workspaceEpoch";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { mocks.text.mockReset(); mocks.read.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("uses the existing editor model without reading disk and opens only on the explicit action", async () => {
  mocks.text.mockReturnValue("draft\ncurrent"); const open = vi.fn();
  await act(async () => root.render(<SourceContextPreview path="D:/p/A.java" line={2} identity="one" onOpen={open} onClose={() => {}} />));
  expect(mocks.read).not.toHaveBeenCalled(); expect(host.textContent).toContain("当前编辑器内容"); expect(open).not.toHaveBeenCalled();
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "打开源码")!.click()); expect(open).toHaveBeenCalledOnce();
});
it("late disk responses cannot replace the new selection or cross a workspace epoch", async () => {
  let finish!: (data: { text: string }) => void;
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ text: "new selection" });
  const render = (path: string) => act(async () => root.render(<SourceContextPreview path={path} line={1} identity="one" onOpen={() => {}} onClose={() => {}} />));
  await render("D:/p/A.java"); await render("D:/p/B.java");
  await act(async () => finish({ text: "old selection" }));
  expect(host.textContent).toContain("new selection"); expect(host.textContent).not.toContain("old selection");
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render("D:/p/C.java"); invalidateWorkspaceRequests();
  await act(async () => finish({ text: "old workspace" }));
  expect(host.textContent).not.toContain("old workspace");
});
it("failed context reads show a retry which recovers in place", async () => {
  mocks.read.mockRejectedValueOnce(new Error("read failed")).mockResolvedValueOnce({ text: "recovered" });
  await act(async () => root.render(<SourceContextPreview path="D:/p/A.java" line={1} identity="one" onOpen={() => {}} onClose={() => {}} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("read failed");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "重试")!.click());
  expect(host.textContent).toContain("recovered");
});
