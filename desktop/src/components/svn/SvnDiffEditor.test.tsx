// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  changed: (() => {}) as () => void,
  cursor: ((_: { position: { lineNumber: number } }) => {}) as (event: { position: { lineNumber: number } }) => void,
  changes: null as null | { originalStartLineNumber: number; originalEndLineNumber: number; modifiedStartLineNumber: number; modifiedEndLineNumber: number }[],
  models: [] as { dispose: ReturnType<typeof vi.fn>; getLineCount: () => number }[],
  viewModels: [] as { model: unknown; dispose: ReturnType<typeof vi.fn>; waitForDiff: () => Promise<void>; resolve: () => void }[],
  create: vi.fn(), options: vi.fn(), attach: vi.fn(), restore: vi.fn(), dispose: vi.fn(), detach: vi.fn(), cursorDetach: vi.fn(),
  reveal: vi.fn(), position: vi.fn(), saved: { original: { cursorState: [], viewState: {} }, modified: { cursorState: [], viewState: {} } },
}));
vi.mock("../../lib/monacoSetup", () => ({ initMonaco: () => ({ editor: {
  createDiffEditor: (_host: HTMLElement, options: object) => {
    mocks.create(options);
    return {
      updateOptions: mocks.options, dispose: mocks.dispose,
      onDidUpdateDiff: (callback: () => void) => { mocks.changed = callback; return { dispose: mocks.detach }; },
      getLineChanges: () => mocks.changes,
      setModel: (model: unknown) => { mocks.attach(model); mocks.changes = null; },
      createViewModel: (model: unknown) => {
        let resolve = () => {};
        const pending = new Promise<void>(done => { resolve = done; });
        const viewModel = { model, dispose: vi.fn(), waitForDiff: () => pending, resolve: () => resolve() };
        mocks.viewModels.push(viewModel); return viewModel;
      },
      saveViewState: () => mocks.saved,
      restoreViewState: mocks.restore,
      getModifiedEditor: () => ({ revealLineInCenter: mocks.reveal, setPosition: mocks.position,
        onDidChangeCursorPosition: (callback: typeof mocks.cursor) => { mocks.cursor = callback; return { dispose: mocks.cursorDetach }; },
      }),
    };
  },
  createModel: (text: string) => { const model = { dispose: vi.fn(), getLineCount: () => text.split("\n").length }; mocks.models.push(model); return model; },
} }) }));

import { SvnDiffEditor } from "./SvnDiffEditor";
import { setSvnDiffPrefs } from "../../lib/svnDiffPrefs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let resize: (entries: { contentRect: { width: number } }[]) => void;
const disconnect = vi.fn();
const changes = [
  { originalStartLineNumber: 0, originalEndLineNumber: 0, modifiedStartLineNumber: 1, modifiedEndLineNumber: 3 },
  { originalStartLineNumber: 4, originalEndLineNumber: 5, modifiedStartLineNumber: 4, modifiedEndLineNumber: 0 },
];

beforeEach(() => {
  vi.clearAllMocks(); mocks.models = []; mocks.viewModels = []; mocks.changes = null;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: typeof resize) { resize = callback; } observe() {} disconnect = disconnect; });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); mocks.viewModels.forEach(vm => vm.resolve()); }); host.remove(); vi.unstubAllGlobals(); });

const render = async (sourceKey: string, workspace = "C:/compare/tests", text = "a\nb\nc\nd") => {
  await act(async () => root.render(<SvnDiffEditor original="old\ncontent" modified={text} sourceKey={sourceKey} root={workspace} originalLabel="BASE r7" modifiedLabel="工作副本" />));
};
const computed = async (value = changes) => { await act(async () => { mocks.changes = value; mocks.changed(); mocks.viewModels[mocks.viewModels.length - 1]?.resolve(); }); };
const button = (text: string) => [...host.querySelectorAll("button")].find(e => e.textContent?.includes(text))!;

describe("SVN 只读差异比较器", () => {
  it("StrictMode 的预清理不缓存空初始视图，首次打开仍定位首处", async () => {
    await act(async()=>root.render(<StrictMode><SvnDiffEditor original="old" modified="new" sourceKey="strict-first-open"/></StrictMode>));
    await computed();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(host.textContent).toContain("第 1 / 2 处");
  });
  it("初始空差异事件不抢先定位，等待 worker 完成后定位首处", async () => {
    await render("initial-worker-result");
    await act(async () => { mocks.changes = []; mocks.changed(); });
    expect(mocks.reveal).not.toHaveBeenCalled();
    await computed();
    expect(mocks.reveal).toHaveBeenLastCalledWith(1);
    expect(host.textContent).toContain("第 1 / 2 处");
  });
  it("计算挂起时卸载保留模型，让已排队的 worker 同步先启动，收尾后再释放", async () => {
    await render("pending-disposal");
    const pair = mocks.models.slice();
    await act(async () => root.unmount());
    // 模拟 Monaco await withWorker 后才检查 worker 是否仍有模型的微任务。
    const workerSync = Promise.resolve().then(() => {
      if (pair.every(model => model.dispose.mock.calls.length > 0)) throw new Error("Canceled");
      return "synced";
    });
    await expect(workerSync).resolves.toBe("synced");
    pair.forEach(model => expect(model.dispose).not.toHaveBeenCalled());
    await act(async () => mocks.viewModels[0].resolve());
    pair.forEach(model => expect(model.dispose).toHaveBeenCalledTimes(1));
    expect(mocks.viewModels[0].dispose).toHaveBeenCalledTimes(1);
    root = createRoot(host);
  });

  it("快速换源不清空 worker 模型，新旧计算分别收尾并释放", async () => {
    await render("pending-source-a");
    const previous = mocks.models.slice();
    await render("pending-source-b");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.models.filter(model => model.dispose.mock.calls.length === 0)).toHaveLength(4);
    await act(async () => mocks.viewModels[0].resolve());
    previous.forEach(model => expect(model.dispose).toHaveBeenCalledTimes(1));
    expect(mocks.models.filter(model => model.dispose.mock.calls.length === 0)).toHaveLength(2);
    await computed();
    await act(async () => root.unmount());
    mocks.models.forEach(model => expect(model.dispose).toHaveBeenCalledTimes(1));
    mocks.viewModels.forEach(vm => expect(vm.dispose).toHaveBeenCalledTimes(1));
    root = createRoot(host);
  });

  it("区分计算与无差异，按实际块定位并禁用首末边界", async () => {
    await render("navigation");
    expect(host.textContent).toContain("计算差异中");
    expect(button("下一处").disabled).toBe(true);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true, originalEditable: false }));
    await computed();
    expect(host.textContent).toContain("+3"); expect(host.textContent).toContain("−2");
    expect(host.textContent).toContain("第 1 / 2 处");
    expect(mocks.reveal).toHaveBeenLastCalledWith(1);
    expect(button("上一处").disabled).toBe(true);
    await act(async () => button("下一处").click());
    expect(host.textContent).toContain("第 2 / 2 处");
    expect(mocks.position).toHaveBeenLastCalledWith({ lineNumber: 4, column: 1 });
    expect(button("下一处").disabled).toBe(true);
    expect(button("上一处").disabled).toBe(false);
    await act(async () => button("上一处").click());
    expect(mocks.reveal).toHaveBeenLastCalledWith(1);
    await act(async () => mocks.cursor({ position: { lineNumber: 4 } }));
    expect(host.textContent).toContain("第 2 / 2 处");
    await computed([]);
    expect(host.textContent).toContain("当前设置下没有差异");
    expect(button("下一处").disabled).toBe(true);
    expect(button("上一处").disabled).toBe(true);
  });

  it("改变阅读偏好只更新选项，空白重算期间不展示旧统计", async () => {
    await render("preferences", "C:/compare/prefs"); await computed();
    const reveals = mocks.reveal.mock.calls.length;
    await act(async () => setSvnDiffPrefs("C:/compare/prefs", { fontSize: 14, wrap: false, layout: "inline", collapseUnchanged: false }));
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.models).toHaveLength(2);
    expect(mocks.options).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 14, lineHeight: 22, diffWordWrap: "off", renderSideBySide: false }));
    expect(mocks.options).toHaveBeenLastCalledWith(expect.objectContaining({ hideUnchangedRegions: expect.objectContaining({ enabled: false }) }));
    expect(mocks.reveal).toHaveBeenCalledTimes(reveals);
    await act(async () => setSvnDiffPrefs("C:/compare/prefs", { ignoreWhitespace: true }));
    expect(host.textContent).toContain("计算差异中");
    expect(host.textContent).toContain("已忽略行首尾空白");
    expect(button("下一处").disabled).toBe(true);
    await computed([]);
    expect(host.textContent).toContain("当前设置下没有差异");
  });

  it("切文件释放旧模型，返回恢复滚动和当前块，卸载释放剩余资源", async () => {
    await render("restore-a"); await computed();
    await act(async () => button("下一处").click());
    const initial = mocks.models.slice();
    await render("restore-b");
    initial.forEach(model => expect(model.dispose).toHaveBeenCalledTimes(1));
    await computed();
    expect(host.textContent).toContain("第 1 / 2 处");
    await render("restore-a"); await computed();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.restore).toHaveBeenCalledWith(mocks.saved);
    expect(host.textContent).toContain("第 2 / 2 处");
    await act(async () => root.unmount());
    mocks.models.forEach(model => expect(model.dispose).toHaveBeenCalledTimes(1));
    expect(mocks.dispose).toHaveBeenCalledTimes(1); expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.cursorDetach).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    root = createRoot(host);
  });

  it("自动跟随实际阅读宽度，用户选择双栏后缩窄不会覆盖偏好", async () => {
    await render("responsive", "C:/compare/narrow");
    await act(async () => resize([{ contentRect: { width: 450 } }]));
    expect(mocks.options).toHaveBeenLastCalledWith(expect.objectContaining({ renderSideBySide: false }));
    await act(async () => button("显示设置").click());
    expect(document.querySelector('[aria-label="差异显示方式"]')?.textContent).toContain("自动 · 单栏");
    await act(async () => setSvnDiffPrefs("C:/compare/narrow", { layout: "sideBySide" }));
    await act(async () => resize([{ contentRect: { width: 300 } }]));
    expect(mocks.options).toHaveBeenLastCalledWith(expect.objectContaining({ renderSideBySide: true }));
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
