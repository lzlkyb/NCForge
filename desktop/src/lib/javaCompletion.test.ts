import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  request: vi.fn(), flush: vi.fn(async () => {}), ready: true, inModule: true,
  types: [] as unknown[],
  capabilityEpoch: 0,
  editors: [] as unknown[],
  provider: null as import("monaco-editor").languages.CompletionItemProvider | null,
  signature: null as import("monaco-editor").languages.SignatureHelpProvider | null,
  toast: vi.fn(),
}));
vi.mock("./monacoSetup", () => ({ monaco: {
  languages: {
    CompletionItemKind: { Method: 0, Class: 5, Property: 9, Text: 18 },
    CompletionItemTag: { Deprecated: 1 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: (_language: string, provider: typeof h.provider) => { h.provider = provider; },
    registerHoverProvider: vi.fn(),
    registerSignatureHelpProvider: (_language: string, provider: typeof h.signature) => { h.signature = provider; },
    registerDefinitionProvider: vi.fn(),
  }, editor: { registerEditorOpener: vi.fn(), getEditors: () => h.editors },
} }));
vi.mock("./editorStore", () => ({ pathOfModel: () => "C:\\ws\\gl\\Demo.java" }));
vi.mock("./lang", () => ({
  flushDoc: () => h.flush(), langReady: () => h.ready, inLangModule: () => h.inModule,
  langCapabilityEpoch: () => h.capabilityEpoch,
  langRequest: (...args: unknown[]) => args[0] === "ncforge/typeCompletion" ? Promise.resolve(h.types) : h.request(...args), loadJdtSource: vi.fn(), navigate: vi.fn(),
}));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: "C:\\ws" }) }));
vi.mock("./search", () => ({ searchWorkspace: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toast: (...args: unknown[]) => h.toast(...args) }));

const POS = { lineNumber: 6, column: 11 } as import("monaco-editor").Position;
const RANGE = { start: { line: 5, character: 4 }, end: { line: 5, character: 10 } };
function model(lines = 20) {
  let version = 1;
  let text = "package demo;\nclass Demo {\nvoid test() {\n\n\n    ArrayL";
  return {
    getLineCount: () => lines, getVersionId: () => version, isDisposed: () => false,
    getValue: () => text,
    getLineContent: (line: number) => text.split("\n")[line - 1] ?? "",
    getOffsetAt: (position: { lineNumber: number; column: number }) => text.split("\n").slice(0, position.lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + position.column - 1,
    getWordUntilPosition: () => ({ word: "ArrayL", startColumn: 5, endColumn: 11 }),
    edit: () => { version++; text = `// changed\n${text}`; },
    type: (suffix: string) => { version++; text += suffix; },
  } as unknown as import("monaco-editor").editor.ITextModel & { edit(): void; type(suffix: string): void };
}
const token = (cancelled = false) => ({ isCancellationRequested: cancelled, onCancellationRequested: vi.fn() });
async function provide(m = model(), ctx = { triggerKind: 0 }, t = token()) {
  return await h.provider!.provideCompletionItems(m, POS, ctx, t);
}
beforeEach(async () => {
  vi.resetModules(); h.provider = null; h.ready = h.inModule = true;
  h.types = [];
  h.capabilityEpoch = 0;
  h.editors = [];
  h.request.mockReset(); h.flush.mockReset(); h.flush.mockResolvedValue(undefined); h.toast.mockReset();
  h.request.mockResolvedValue({ items: [{ label: "ArrayList - java.util", kind: 7, insertText: "ArrayList", filterText: "ArrayList", data: { id: "1" } }] });
  const { registerLangProviders } = await import("./langProviders");
  registerLangProviders();
});

describe("Java 语义补全", () => {
  it("类名前缀调用语言服务并保留独立过滤名称", async () => {
    const result = await provide();
    expect(result?.suggestions[0]).toMatchObject({ label: "ArrayList - java.util", insertText: "ArrayList", filterText: "ArrayList", kind: 5 });
    expect(h.flush).toHaveBeenCalledTimes(1);
  });
  it("2000 行以上的有效 Java 源码也能补全", async () => {
    expect((await provide(model(6500)))?.suggestions[0].label).toBe("ArrayList - java.util");
    expect(h.request).toHaveBeenCalled();
  });
  it("取消后不发请求", async () => {
    expect(await provide(model(), { triggerKind: 0 }, token(true))).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("返回时文本已经改变，丢弃旧光标位置的结果", async () => {
    const m = model();
    h.request.mockImplementation(async () => { m.edit(); return { items: [{ label: "Old" }] }; });
    expect(await provide(m)).toBeNull();
  });
  it("满额候选不能只在旧 50 条中继续过滤，后续输入应重新查询", async () => {
    h.request.mockResolvedValue({ isIncomplete: false, items: Array.from({ length: 50 }, (_, i) => ({ label: `A${i}` })) });
    expect((await provide())?.incomplete).toBe(true);
  });
  it("点号触发上下文按 LSP 枚举发送", async () => {
    await provide(model(), { triggerKind: 1, triggerCharacter: "." } as { triggerKind: number });
    expect(h.request).toHaveBeenCalledWith("textDocument/completion", "C:\\ws\\gl\\Demo.java", expect.objectContaining({ context: { triggerKind: 2, triggerCharacter: "." } }), expect.any(Number));
  });
  it("服务未就绪或文件不属于当前模块时不发语义请求", async () => {
    h.ready = false; expect(await provide()).toBeNull();
    h.ready = true; h.inModule = false; expect(await provide()).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("文档同步失败结束补全等待并说明原因", async () => {
    h.flush.mockRejectedValue(new Error("sync failed"));
    expect(await provide()).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalled();
  });
  it("保留插入与替换两个范围，光标在词中间时不会重复尾部", async () => {
    h.request.mockResolvedValue({ items: [{ label: "ArrayList", textEdit: { newText: "ArrayList", insert: RANGE, replace: { ...RANGE, end: { line: 5, character: 13 } } } }] });
    expect((await provide())?.suggestions[0].range).toHaveProperty("insert");
    expect((await provide())?.suggestions[0].range).toHaveProperty("replace");
  });
  it("废弃方法带废弃标记", async () => {
    h.request.mockResolvedValue({ items: [{ label: "old", kind: 2, deprecated: true }] });
    expect((await provide())?.suggestions[0].tags).toEqual([1]);
  });
  it("选中未导入的类时才解析并补齐 import", async () => {
    const item = (await provide())!.suggestions[0];
    expect(h.provider!.resolveCompletionItem).toBeTypeOf("function");
    h.request.mockResolvedValue({ label: "ArrayList - java.util", kind: 7, filterText: "ArrayList", textEdit: { newText: "ArrayList", range: RANGE }, additionalTextEdits: [{ newText: "import java.util.ArrayList;\n", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } } }] });
    const resolved = await h.provider!.resolveCompletionItem!(item, token());
    expect(h.request).toHaveBeenLastCalledWith("completionItem/resolve", null, expect.objectContaining({ data: { id: "1" } }), expect.any(Number));
    expect(resolved?.additionalTextEdits?.[0].text).toContain("import java.util.ArrayList");
  });
  it("方法解析后插入参数占位符并自动显示参数提示", async () => {
    const item = (await provide())!.suggestions[0];
    expect(h.provider!.resolveCompletionItem).toBeTypeOf("function");
    h.request.mockResolvedValue({ label: "append(String value)", kind: 2, insertTextFormat: 2, textEdit: { newText: "append(${1:value})", range: RANGE } });
    const resolved = await h.provider!.resolveCompletionItem!(item, token());
    expect(resolved?.insertText).toBe("append(${1:value})");
    expect(resolved?.insertTextRules).toBe(4);
    expect(resolved?.command?.id).toBe("editor.action.triggerParameterHints");
  });
  it("解析期间修改文本，不应用旧范围的导入编辑", async () => {
    const m = model(); const item = (await provide(m))!.suggestions[0];
    expect(h.provider!.resolveCompletionItem).toBeTypeOf("function");
    m.edit();
    expect(await h.provider!.resolveCompletionItem!(item, token())).toBe(item);
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it("候选解析期间继续输入同一前缀，替换范围随前缀增长，导入位置保持正确", async () => {
    const m = model(); const item = (await provide(m))!.suggestions[0];
    h.request.mockImplementation(async () => {
      m.type("ist");
      return { label: "ArrayList", textEdit: { newText: "ArrayList", range: RANGE }, additionalTextEdits: [{ newText: "import java.util.ArrayList;\n", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } } }] };
    });
    const resolved = await h.provider!.resolveCompletionItem!(item, token());
    expect(resolved?.range).toMatchObject({ startColumn: 5, endColumn: 14 });
    expect(resolved?.additionalTextEdits?.[0].range).toMatchObject({ startLineNumber: 2, endLineNumber: 2, startColumn: 1 });
  });
  it("同一候选并发解析共享请求，成功后缓存", async () => {
    const item = (await provide())!.suggestions[0];
    h.request.mockResolvedValue({ label: "ArrayList", detail: "java.util" });
    await Promise.all([h.provider!.resolveCompletionItem!(item, token()), h.provider!.resolveCompletionItem!(item, token())]);
    await h.provider!.resolveCompletionItem!(item, token());
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it("解析失败保留候选，下次可以重试", async () => {
    const item = (await provide())!.suggestions[0];
    h.request.mockRejectedValueOnce(new Error("temporary"));
    await h.provider!.resolveCompletionItem!(item, token());
    h.request.mockResolvedValue({ label: "ArrayList", detail: "java.util" });
    expect(await h.provider!.resolveCompletionItem!(item, token())).toMatchObject({ detail: "java.util" });
    expect(h.request).toHaveBeenCalledTimes(3);
  });
  it("全 NC 未加载类参与前缀补全，选择后同步文本并按需加载", async () => {
    h.types = [{ label: "ArrayLocal - nc.vo", kind: 7, insertText: "nc.vo.ArrayLocal", detail: "nc.vo.ArrayLocal · NC 按需载入", data: { ncfType: "nc.vo.ArrayLocal" } }];
    const result = await provide();
    expect(result?.suggestions).toHaveLength(2);
    expect(result?.incomplete).toBe(true);
    h.request.mockResolvedValue({ insertText: "ArrayLocal", detail: "nc.vo.ArrayLocal" });
    await h.provider!.resolveCompletionItem!(result!.suggestions[1], token());
    expect(h.flush).toHaveBeenCalledTimes(2);
    expect(h.request).toHaveBeenLastCalledWith("ncforge/resolveTypeCompletion", "C:\\ws\\gl\\Demo.java", { name: "nc.vo.ArrayLocal", position: { line: 5, character: 10 } }, 15000);
  });
  it("JDT 已有的类不重复添加全库候选", async () => {
    h.request.mockResolvedValue({ items: [{ label: "ArrayList", detail: "java.util.ArrayList" }] });
    h.types = [{ label: "ArrayList - java.util", data: { ncfType: "java.util.ArrayList" } }];
    expect((await provide())?.suggestions).toHaveLength(1);
  });
  it("NC 类在继续输入后解析，JDT 当前范围不能重复加上前缀增长", async () => {
    h.types = [{ label: "ArrayLocal", data: { ncfType: "nc.vo.ArrayLocal" } }];
    const m = model(), item = (await provide(m))!.suggestions[1];
    m.type("ocal");
    h.request.mockResolvedValue({ label: "ArrayLocal", textEdit: { newText: "ArrayLocal", range: { start: { line: 5, character: 4 }, end: { line: 5, character: 14 } } } });
    expect(await h.provider!.resolveCompletionItem!(item, token())).toMatchObject({ range: { endColumn: 15 } });
  });
  it("同一文件服务重启后，旧候选不能在新 JDT 会话解析", async () => {
    const item = (await provide())!.suggestions[0];
    h.capabilityEpoch++;
    await h.provider!.resolveCompletionItem!(item, token());
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it("参数提示传递逗号触发上下文并限制服务器返回的越界索引", async () => {
    h.request.mockResolvedValue({ signatures: [{ label: "get(int index)", parameters: [{ label: [4, 13] }] }], activeSignature: 99, activeParameter: 99 });
    const hints = await h.signature!.provideSignatureHelp(model(), POS, token(), { triggerKind: 2, triggerCharacter: ",", isRetrigger: true });
    expect(hints?.value).toMatchObject({ activeSignature: 0, activeParameter: 0 });
    expect(h.request).toHaveBeenLastCalledWith("textDocument/signatureHelp", expect.any(String), expect.objectContaining({ context: { triggerKind: 2, triggerCharacter: ",", isRetrigger: true } }), undefined);
  });
  it("参数提示返回期间文本改变，不显示旧参数位置", async () => {
    const m = model();
    h.request.mockImplementation(async () => { m.edit(); return { signatures: [{ label: "old()" }] }; });
    expect(await h.signature!.provideSignatureHelp(m, POS, token(), { triggerKind: 1, isRetrigger: false })).toBeNull();
  });
  it("已解析候选在继续输入前缀后仍使用当前替换范围", async () => {
    const m = model(), item = (await provide(m))!.suggestions[0];
    h.request.mockResolvedValue({ label: "ArrayList", textEdit: { newText: "ArrayList", range: RANGE } });
    await h.provider!.resolveCompletionItem!(item, token());
    m.type("is");
    expect(await h.provider!.resolveCompletionItem!(item, token())).toMatchObject({ range: { endColumn: 13 } });
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it("已解析候选失效后清除旧导入编辑", async () => {
    const m = model(), item = (await provide(m))!.suggestions[0];
    h.request.mockResolvedValue({ label: "ArrayList", additionalTextEdits: [{ newText: "import java.util.ArrayList;\n", range: RANGE }] });
    await h.provider!.resolveCompletionItem!(item, token());
    m.edit();
    expect(await h.provider!.resolveCompletionItem!(item, token())).toMatchObject({ additionalTextEdits: undefined });
  });
  it("同时解析两个 NC 类型时，各自加载并保留自己的结果", async () => {
    h.types = ["One", "Two"].map(s => ({ label: "ArrayLocal" + s, data: { ncfType: "nc.vo.ArrayLocal" + s } }));
    const list = (await provide())!.suggestions;
    h.request.mockImplementation(async (_method, _path, args) => ({ detail: args.name, insertText: args.name }));
    const results = await Promise.all([h.provider!.resolveCompletionItem!(list[1], token()), h.provider!.resolveCompletionItem!(list[2], token())]);
    expect(results.map(r => r?.detail)).toEqual(["nc.vo.ArrayLocalOne", "nc.vo.ArrayLocalTwo"]);
  });
  it("候选预览取消后，接受同一候选仍能拿到共享请求的导入", async () => {
    const item = (await provide())!.suggestions[0], preview = token();
    let finish!: (value: unknown) => void;
    h.request.mockImplementation(() => new Promise(ok => { finish = ok; }));
    const p1 = h.provider!.resolveCompletionItem!(item, preview);
    preview.isCancellationRequested = true;
    const p2 = h.provider!.resolveCompletionItem!(item, token());
    finish({ label: "ArrayList", additionalTextEdits: [{ newText: "import java.util.ArrayList;\n", range: RANGE }] });
    const [, accepted] = await Promise.all([p1, p2]);
    expect(accepted?.additionalTextEdits?.[0].text).toContain("import java.util.ArrayList");
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it("接受之后切换编辑器模型，迟到的导入不会写入另一个文件", async () => {
    const m = model(); let shown = m;
    h.editors = [{ getModel: () => shown, hasTextFocus: () => true }];
    const item = (await provide(m))!.suggestions[0];
    h.request.mockImplementation(async () => {
      shown = model();
      return { additionalTextEdits: [{ newText: "import java.util.ArrayList;\n", range: RANGE }] };
    });
    expect(await h.provider!.resolveCompletionItem!(item, token())).toMatchObject({ additionalTextEdits: undefined });
  });
});
