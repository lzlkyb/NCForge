// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryFileResults } from "./LibraryFileResults";
import { getSearchForm, resetSearchForm, setSearchForm } from "../../lib/searchStore";
import type { LibraryOutcome } from "../../lib/libraryFiles";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const outcome: LibraryOutcome = { items: [{ source: "D:/NC/modules/pp/hyext/lib/same.jar", entry: "conf/a.xml", archive: true, class: false,
  line: 12, text: "😀单据", ranges: [{ start: 2, end: 4 }] }], building: false, stale: false, cancelled: false, truncated: false, scanned: 3, skipped: 0, error: null };
const options = { text: " 单据$ ", regex: true, caseSensitive: true, wholeWord: false, include: "*.xml", dirs: ["pp"] };
function completed(id = 1) {
  setSearchForm({ resultId: id, outcomeQuery: "单据$", libraryOptions: { ...options }, running: false,
    projectOutcome: { projects: [], elapsedMs: 0, truncated: false } as never });
}
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); resetSearchForm(); mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((command: string) => Promise.resolve(command === "search_library_files" ? outcome : undefined)); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe("库文件结果", () => {
  it("使用跨工程条件快照，正确高亮 UTF16 并只读打开准确来源", async () => {
    completed(); const open = vi.fn();
    await act(async () => root.render(<LibraryFileResults onOpen={open} />));
    expect(mocks.invoke).toHaveBeenCalledWith("search_library_files", expect.objectContaining({ options: { ...options, maxResults: 100 }, names: false }));
    expect(container.querySelector("mark")?.textContent).toBe("单据"); expect(container.textContent).toContain("hyext/lib/same.jar");
    await act(async () => container.querySelector<HTMLButtonElement>("button[title]")!.click()); expect(open).toHaveBeenCalledWith(outcome.items[0]);
    const calls = mocks.invoke.mock.calls.filter(c => c[0] === "search_library_files").length;
    await act(async () => setSearchForm({ query: "另外输入" }));
    expect(mocks.invoke.mock.calls.filter(c => c[0] === "search_library_files")).toHaveLength(calls);
  });
  it("旧请求不能覆盖新结果，准备中和失败可重试", async () => {
    let finish!: (r: LibraryOutcome) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<LibraryOutcome>(resolve => { finish = resolve; }));
    completed(); await act(async () => root.render(<LibraryFileResults onOpen={vi.fn()} />));
    mocks.invoke.mockImplementation(command => Promise.resolve(command === "search_library_files" ? { ...outcome, items: [], building: true } : undefined));
    await act(async () => { completed(2); });
    await act(async () => finish(outcome));
    expect(getSearchForm().libraryFiles?.building).toBe(true); expect(container.textContent).toContain("后台建立");
    mocks.invoke.mockImplementation(command => Promise.resolve(command === "search_library_files" ? { ...outcome, error: "读取失败" } : undefined));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.textContent).toContain("读取失败");
  });
});
