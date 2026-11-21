// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ buildItems: vi.fn(), run: vi.fn(), projects: vi.fn(), cancel: vi.fn(), open: vi.fn() }));

vi.mock("../../lib/paletteSources", () => ({ buildItems: deps.buildItems }));
vi.mock("../../lib/search", () => ({ searchProjectsStream: deps.projects, cancelSearch: deps.cancel }));
vi.mock("../../lib/searchOpenRequest", () => ({ requestSearchOpen: deps.open }));
vi.mock("../../lib/libraryFiles", () => ({ cancelLibrarySearch: vi.fn(), searchLibraryFiles: vi.fn(async () => ({ items: [] })) }));
vi.mock("../../lib/fileIndex", () => ({ getLinkedFileIndex: vi.fn(async () => ({})) }));
vi.mock("../../lib/lang", () => ({ navigate: vi.fn() }));
vi.mock("../../hooks/useDocumentSymbols", () => ({ useDocumentSymbols: () => ({ symbols: EMPTY_SYMBOLS, supported: false }) }));
const EMPTY_SYMBOLS: [] = [];
vi.mock("../../lib/openFileRequest", () => ({ requestOpenFile: vi.fn() }));
vi.mock("../../lib/workspaceSession", () => ({
  useWorkspaceSelector: (sel: (s: { root: string; activePath: null; tabs: [] }) => unknown) =>
    sel({ root: "C:\\w", activePath: null, tabs: [] }),
}));

import { QuickPalette } from "./QuickPalette";
vi.mock("../../lib/searchRunner", () => ({ runWorkspaceSearch: deps.run }));
vi.mock("./PaletteWorkspaceSearch", () => ({ PaletteWorkspaceSearch: () => <div><select aria-label="测试范围"><option>当前</option></select><div tabIndex={0} aria-label="搜索结果列表" /></div> }));

import { getSearchForm, setSearchForm, resetSearchForm } from "../../lib/searchStore";
import { closePalette, openPalette } from "../../lib/paletteStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  // jsdom 没有布局，scrollIntoView 需要补一个空实现
  Element.prototype.scrollIntoView = vi.fn();
  deps.buildItems.mockReset(); deps.run.mockReset(); resetSearchForm(); setSearchForm({ query: "" });
  deps.open.mockReset(); deps.cancel.mockReset();
  deps.projects.mockReset().mockResolvedValue({ projects: [], errors: [], truncated: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    closePalette();
    root.unmount();
  });
  container.remove();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const listbox = () => document.querySelector<HTMLElement>("#qp-listbox");

async function flush() {
  await act(async () => {
    await tick();
  });
}

function type(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="快速导航输入"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("快速导航浮层的查询状态", () => {
  it("预览卸载后焦点落到 body，Escape 仍关闭浮层并恢复原焦点", async () => {
    deps.buildItems.mockResolvedValue({ items: [], note: "" });
    const origin = document.createElement("button"); document.body.append(origin); origin.focus();
    openPalette("file"); act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />)); await flush();
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[data-palette]')).toBeNull(); expect(document.activeElement).toBe(origin); origin.remove();
  });
  it("跨工具定位预填类名，正常重开清空旧查询", async () => {
    deps.buildItems.mockResolvedValue({ items: [], note: "" });
    openPalette("type", "nc.impl.ic.StockService");
    act(() => root.render(<QuickPalette activeTab="logs" onNavigate={vi.fn()} />));
    await flush();
    expect(container.querySelector<HTMLInputElement>('[aria-label="快速导航输入"]')?.value).toBe("nc.impl.ic.StockService");
    act(() => { closePalette(); openPalette("file"); }); await flush();
    expect(container.querySelector<HTMLInputElement>('[aria-label="快速导航输入"]')?.value).toBe("");
  });
  it("默认只有一个搜索框，完整搜索沿用关键词并重置正文范围", async () => {
    deps.buildItems.mockResolvedValue({ items: [], note: "" });
    openPalette("file");
    act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />));
    await flush();

    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    type("非ICL客户不能同步");
    act(() => setSearchForm({ scope: "component", include: "*.xml", regex: true }));
    act(() => container.querySelector("button")!.click());
    await flush();
    expect(getSearchForm()).toMatchObject({ query: "非ICL客户不能同步", scope: "all", include: "", regex: false });
    expect(deps.run).toHaveBeenCalledWith("C:\\w");
  });

  it("全局搜索直接高亮正文，流式结果到达后保留手动选中项，导航用源文件列号", async () => {
    const runFile = vi.fn();
    deps.buildItems.mockImplementation(async mode => ({ items: mode === "file" ? [
      { key: "first", title: "文件一.java", run: vi.fn() }, { key: "second", title: "文件二.java", run: runFile },
    ] : [], note: "" }));
    const phrase = "非ICL客户不能同步";
    const emit = vi.fn();
    deps.projects.mockImplementation((_options, onBatch) => {
      emit.mockImplementation(onBatch);
      return new Promise(() => {});
    });
    openPalette("file", phrase);
    act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />));
    await flush();
    const input = container.querySelector("input")!;
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(deps.projects).toHaveBeenCalledWith(expect.objectContaining({ text: phrase }), expect.any(Function), expect.any(String), expect.any(Function));
    act(() => emit({ root: "C:/w", project: "工程", hits: [{ path: "Source.java", line: 26, column: 401,
      text: `…${phrase}`, ranges: [{ start: 1, end: 1 + phrase.length }] }] }));
    expect(container.querySelector("mark")?.textContent).toBe(phrase);
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain("文件二.java");
    act(() => container.querySelector<HTMLElement>('[data-group="正文"]')!.click());
    expect(deps.open).toHaveBeenCalledWith({ kind: "file", path: "C:/w/Source.java", line: 26, column: 401 });
    expect(runFile).not.toHaveBeenCalled();
  });

  it("代码前缀按原样搜索，跨行粘贴保留换行", async () => {
    deps.buildItems.mockResolvedValue({ items: [], note: "" });
    openPalette("file");
    act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />));
    type("#include");
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("#include");
    const input = container.querySelector("input")!;
    input.setSelectionRange(0, input.value.length);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "第一行\r\n第二行" } });
    act(() => input.dispatchEvent(paste));
    expect(container.querySelector("textarea")?.value).toBe("第一行\n第二行");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(deps.projects).toHaveBeenCalledWith(expect.objectContaining({ text: "第一行\n第二行" }), expect.any(Function), expect.any(String), expect.any(Function));
  });

  it("查询失败给出原因和重试按钮，重试成功后列表恢复", async () => {
    deps.buildItems.mockRejectedValueOnce(new Error("语言服务挂了"));
    openPalette("cmd");
    act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />));
    await flush();

    expect(container.textContent).toContain("查询失败：语言服务挂了");
    const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "重试")!;
    deps.buildItems.mockResolvedValueOnce({ items: [{ key: "a", title: "编译当前模块", run: vi.fn() }], note: "命令" });
    act(() => retry.click());
    await flush();

    expect(container.textContent).toContain("编译当前模块");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "重试")).toBe(false);
  });

  it("换查询保留旧结果，加载中回车不误开上一轮的条目", async () => {
    const oldRun = vi.fn();
    deps.buildItems.mockResolvedValueOnce({ items: [{ key: "a", title: "旧结果", run: oldRun }], note: "命令" });
    openPalette("cmd");
    act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />));
    await flush();
    expect(container.textContent).toContain("旧结果");

    let resolveNext: (value: unknown) => void = () => {};
    deps.buildItems.mockReturnValueOnce(new Promise((r) => { resolveNext = r; }));
    type("新查询");
    await flush();
    // 不清空列表：慢查询时才不会「闪成空白 + 一直查询中」的假死观感
    expect(container.textContent).toContain("旧结果");
    expect(container.textContent).toContain("更新中");
    expect(listbox()?.getAttribute("aria-busy")).toBe("true");

    // 但列表里是上一轮的条目：加载期间按回车不能把它打开
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="快速导航输入"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(oldRun).not.toHaveBeenCalled();

    await act(async () => {
      resolveNext({ items: [{ key: "b", title: "新结果", run: vi.fn() }], note: "命令" });
      await tick();
    });
    expect(container.textContent).toContain("新结果");
    expect(listbox()?.getAttribute("aria-busy")).toBe("false");
  });

  it("输入 # 加空格切入工程搜索，只有一个查询框，Enter 提交且组词不提交", async () => {
    deps.buildItems.mockResolvedValue({ items: [], note: "" });
    openPalette("file"); act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />)); await flush();
    type("# 凭证保存"); await flush();
    const input = container.querySelector<HTMLInputElement>('[aria-label="搜索工程文件内容"]')!;
    expect(input.value).toBe("凭证保存"); expect(container.querySelectorAll("input")).toHaveLength(1);
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })));
    expect(deps.run).not.toHaveBeenCalled();
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(deps.run).toHaveBeenCalledWith("C:\\w");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(container.querySelector('[aria-label="搜索结果列表"]'));
  });

  it("模式重挂载保留原焦点，Esc 关闭后查询保留，重开恢复查询", async () => {
    const origin = document.createElement("button"); document.body.append(origin); origin.focus();
    deps.buildItems.mockResolvedValue({ items: [], note: "" });
    openPalette("file"); act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />)); await flush();
    type("# 保存"); await flush();
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(origin); expect(getSearchForm().query).toBe("保存");
    act(() => openPalette("search")); await flush();
    expect(container.querySelector<HTMLInputElement>('[aria-label="搜索工程文件内容"]')!.value).toBe("保存");
    origin.remove();
  });

  it("Tab 焦点循环覆盖范围控件和结果列表", async () => {
    openPalette("search"); act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />)); await flush();
    const first = container.querySelector<HTMLInputElement>("input")!, last = container.querySelector<HTMLElement>('[aria-label="搜索结果列表"]')!;
    act(() => { last.focus(); last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); });
    expect(document.activeElement).toBe(first);
    act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(last);
  });
});
