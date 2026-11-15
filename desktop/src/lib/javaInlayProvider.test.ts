import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ provider: null as unknown, enabled: false, version: 1, epoch: 1, capability: 1, context: vi.fn(), request: vi.fn() }));
vi.mock("./monacoSetup", () => ({ monaco: { languages: { registerInlayHintsProvider: (_language: string, provider: unknown) => { mocks.provider = provider; }, InlayHintKind: { Parameter: 2, Type: 1 } } } }));
vi.mock("./langProviderContext", () => ({ context: (...args: unknown[]) => mocks.context(...args) }));
vi.mock("./lang", () => ({ langRequest: (...args: unknown[]) => mocks.request(...args), langCapabilityEpoch: () => mocks.capability }));
vi.mock("./editorPrefs", () => ({ getEditorPrefs: () => ({ inlayHints: mocks.enabled }) }));
vi.mock("./workspaceEpoch", () => ({ workspaceEpoch: () => mocks.epoch }));
import { registerJavaParameterHints } from "./javaParameterHints";
const model = (text: string) => ({
  getValue: () => text, getVersionId: () => mocks.version, isDisposed: () => false,
  getOffsetAt: (position: { column: number }) => position.column - 1,
  getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }), getLineMaxColumn: () => text.length + 1,
});
type HintResult = { hints: { label: string; kind: number; position: { column: number } }[] } | null;
const invoke = (sourceModel: ReturnType<typeof model>) => (mocks.provider as { provideInlayHints: (...args: unknown[]) => Promise<HintResult> }).provideInlayHints(sourceModel, { startLineNumber: 1, endLineNumber: 1 }, { isCancellationRequested: false });
beforeEach(() => {
  mocks.enabled = true; mocks.version = mocks.epoch = mocks.capability = 1;
  mocks.context.mockReset().mockImplementation(async (_model: unknown, position: unknown) => ({ path: "D:/Demo.java", position }));
  mocks.request.mockReset().mockResolvedValue({ contents: { language: "java", value: "String item" } });
  registerJavaParameterHints();
});
afterEach(() => { vi.useRealTimers(); });
describe("参数名与lambda类型共享内联提示provider", () => {
  it("默认关闭时不发请求", async () => {
    mocks.enabled = false; expect(await invoke(model("item -> item"))).toBeNull(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("使用真实hover声明类型，在隐式参数后显示类型", async () => {
    const source = "item -> item.trim()", result = await invoke(model(source));
    expect(result?.hints).toEqual([{ label: ": String", kind: 1, position: { lineNumber: 1, column: 5 }, paddingLeft: true }]);
    expect(mocks.request).toHaveBeenCalledWith("textDocument/hover", "D:/Demo.java", { position: { lineNumber: 1, column: 1 } }, expect.any(Number));
  });
  it("未知语义类型保持空白，不写猜测类型", async () => {
    mocks.request.mockResolvedValue({ contents: "No information" }); expect((await invoke(model("item -> item")))?.hints).toEqual([]);
  });
  it("同一model版本缓存hover，编辑或语言服务换代后重查", async () => {
    const sourceModel = model("item -> item");
    await invoke(sourceModel); await invoke(sourceModel); expect(mocks.request).toHaveBeenCalledTimes(1);
    mocks.version++; await invoke(sourceModel); mocks.capability++; await invoke(sourceModel); expect(mocks.request).toHaveBeenCalledTimes(3);
  });
  it.each(["version", "epoch", "capability"] as const)("hover等待期间%s变化时丢弃类型提示", async key => {
    mocks.request.mockImplementationOnce(async () => { mocks[key]++; return { contents: "String item" }; });
    expect(await invoke(model("item -> item"))).toBeNull();
  });
  it("参数名与类型提示共用最多8次请求", async () => {
    mocks.request.mockImplementation(async (method: string) => method === "textDocument/hover" ? { contents: "String item" } : { signatures: [{ label: "load(int count)", parameters: [{ label: "int count" }] }] });
    const source = Array.from({ length: 12 }, (_, index) => `Consumer<String> c${index} = item -> load(1)`).join(";");
    const result = await invoke(model(source));
    expect(mocks.request).toHaveBeenCalledTimes(8);
    expect(mocks.request.mock.calls.filter(call => call[0] === "textDocument/hover")).toHaveLength(4);
    expect(mocks.request.mock.calls.filter(call => call[0] === "textDocument/signatureHelp")).toHaveLength(4);
    expect(result?.hints.map(hint => hint.label)).toContain(": String"); expect(result?.hints.map(hint => hint.label)).toContain("count:");
  });
  it("共享2.5秒总预算，剩余单次请求预算不超过1秒", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    mocks.request.mockImplementation(async () => { vi.setSystemTime(Date.now() + 1000); return { contents: "String item" }; });
    await invoke(model("item -> item; item -> item; item -> item; item -> item"));
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(mocks.request.mock.calls.map(call => call[3])).toEqual([1000, 1000, 500]);
  });
});
