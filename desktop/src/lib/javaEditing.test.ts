import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  formatting: null as unknown,
  commands: [] as { id: string; run: () => void }[],
  version: 1, epoch: 1, capability: 1,
  context: vi.fn(), request: vi.fn(), run: vi.fn(),
}));
vi.mock("./monacoSetup", () => ({ monaco: {
  languages: { registerCompletionItemProvider: vi.fn(), registerDocumentRangeFormattingEditProvider: (_language: string, provider: unknown) => { mocks.formatting = provider; } },
} }));
vi.mock("./commandRegistry", () => ({ registerCommands: (commands: typeof mocks.commands) => { mocks.commands = commands; } }));
vi.mock("./langProviderContext", () => ({ context: (...args: unknown[]) => mocks.context(...args) }));
vi.mock("./lang", () => ({ langRequest: (...args: unknown[]) => mocks.request(...args), langCapabilityEpoch: () => mocks.capability }));
vi.mock("./langConvert", () => ({ toMonacoRange: (value: unknown) => value }));
vi.mock("./editorPrefs", () => ({ getEditorPrefs: vi.fn() }));
vi.mock("./workspaceEpoch", () => ({ workspaceEpoch: () => mocks.epoch }));
vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));
vi.mock("./javaPasteImports", () => ({ findPasteImports: vi.fn() }));
vi.mock("./javaEditingDialogStore", () => ({ showJavaEditingDialog: vi.fn() }));
vi.mock("./javaParameterHints", () => ({ registerJavaParameterHints: vi.fn() }));
vi.mock("./editorActions", () => ({ runEditorCommand: (...args: unknown[]) => mocks.run(...args), currentIsJava: () => true, currentSelection: () => ({ readOnly: false }) }));
import { registerJavaEditingProviders } from "./javaEditing";
registerJavaEditingProviders();
const range = { startLineNumber: 2, startColumn: 3, endLineNumber: 8, endColumn: 4 };
const edit = { range: { start: { line: 1, character: 2 }, end: { line: 7, character: 3 } }, newText: "formatted" };
const provider = () => mocks.formatting as { provideDocumentRangeFormattingEdits: (...args: unknown[]) => Promise<unknown> };
const invoke = () => provider().provideDocumentRangeFormattingEdits({ getVersionId: () => mocks.version, isDisposed: () => false }, range, { tabSize: 4, insertSpaces: true }, { isCancellationRequested: false });
beforeEach(() => {
  mocks.version = mocks.epoch = mocks.capability = 1;
  mocks.context.mockReset().mockResolvedValue({ path: "D:/A.java", position: { line: 1, character: 2 } });
  mocks.request.mockReset().mockResolvedValue([edit]); mocks.run.mockReset();
});
describe("Java编辑动作归属与选区格式化", () => {
  it("命令交给当前编辑器，避免同一model分屏时误选第一个实例", () => {
    mocks.commands.find(command => command.id === "java.doc")!.run();
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith("ncforge.java.doc");
  });
  it("按1基选区发送0基格式化请求", async () => {
    expect(await invoke()).toEqual([{ range: edit.range, text: "formatted" }]);
    expect(mocks.request).toHaveBeenCalledWith("textDocument/rangeFormatting", "D:/A.java", {
      range: { start: { line: 1, character: 2 }, end: { line: 7, character: 3 } }, options: { tabSize: 4, insertSpaces: true },
    });
  });
  it("同步阶段语言服务换代后不再发请求", async () => {
    mocks.context.mockImplementationOnce(async () => { mocks.capability++; return { path: "D:/A.java" }; });
    expect(await invoke()).toBeNull(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(["version", "epoch", "capability"] as const)("请求期间%s变化后丢弃过期编辑", async key => {
    mocks.request.mockImplementationOnce(async () => { mocks[key]++; return [edit]; });
    expect(await invoke()).toBeNull();
  });
});
