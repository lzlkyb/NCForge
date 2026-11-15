import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn(), request: vi.fn(), epoch: 1, ready: true }));
vi.mock("./monacoSetup", () => ({ monaco: { editor: { EditorOption: { readOnly: 0 } } } }));
vi.mock("./typeSearch", () => ({ searchTypes: mocks.search }));
vi.mock("./editorStore", () => ({ pathOfModel: () => "D:/ws/A.java" }));
vi.mock("./lang", () => ({ langReady: () => mocks.ready, langRequest: mocks.request, flushDoc: async () => {} }));
vi.mock("./workspaceEpoch", () => ({ workspaceEpoch: () => mocks.epoch }));
import { applyPasteImports, findPasteImports } from "./javaPasteImports";
import { getJavaEditingDialog, showJavaEditingDialog, type JavaImportRequest } from "./javaEditingDialogStore";

function fixture() {
  const state = { version: 1, readOnly: false };
  const model = { getLanguageId: () => "java", getValue: () => "class A {}", getVersionId: () => state.version, isDisposed: () => false,
    getPositionAt: () => ({ lineNumber: 1, column: 1 }), pushEditOperations: vi.fn() };
  const editor = { getModel: () => model, getOption: () => state.readOnly };
  return { state, model, editor, request: { editor, model, path: "D:/ws/A.java", version: 1, epoch: 1,
    choices: [{ simple: "Foo", names: [{ name: "nc.a.Foo", source: "D:/nchome/a.jar", library: true }, { name: "nc.b.Foo", source: "D:/nchome/b.jar", library: true }] }], notes: [] } as unknown as JavaImportRequest };
}
beforeEach(() => { mocks.epoch = 1; mocks.ready = true; mocks.request.mockReset().mockResolvedValue({}); mocks.search.mockReset(); showJavaEditingDialog(null); });

describe("粘贴导入链路", () => {
  it("保留同名类候选与准确来源供用户选择", async () => {
    mocks.search.mockResolvedValue({ workspace: [], jars: [{ name: "nc.a.Foo", simple: "Foo", jar: "D:/a.jar" }, { name: "nc.b.Foo", simple: "Foo", jar: "D:/b.jar" }], indexing: false, jarsPending: false });
    const { editor } = fixture(); await findPasteImports(editor as never, "Foo value;");
    const state = getJavaEditingDialog();
    expect(state?.kind).toBe("imports");
    if (state?.kind === "imports") expect(state.request.choices[0].names.map(item => item.source)).toEqual(["D:/a.jar", "D:/b.jar"]);
  });
  it("所选NC库类先载入依赖，再仅应用导入编辑", async () => {
    const { request, model } = fixture();
    expect(await applyPasteImports(request, ["nc.a.Foo"])).toBe(1);
    expect(mocks.request).toHaveBeenCalledWith("ncforge/resolveTypeCompletion", "D:/ws/A.java", expect.objectContaining({ name: "nc.a.Foo" }), 20_000);
    expect(model.pushEditOperations.mock.calls[0][1][0].text).toBe("import nc.a.Foo;\n");
  });
  it("未选来源、跨工程旧结果、只读与修改冲突都不能写入", async () => {
    const { request, state, model } = fixture();
    expect(await applyPasteImports(request, [])).toBe(0);
    await expect(applyPasteImports(request, ["unknown.Foo"])).rejects.toThrow("过期");
    state.version++; await expect(applyPasteImports(request, ["nc.a.Foo"])).rejects.toThrow("修改");
    state.version = 1; state.readOnly = true; await expect(applyPasteImports(request, ["nc.a.Foo"])).rejects.toThrow();
    expect(model.pushEditOperations).not.toHaveBeenCalled();
  });
  it("依赖载入期间继续编辑时丢弃旧导入坐标", async () => {
    const { request, state, model } = fixture(); mocks.request.mockImplementation(async () => { state.version++; return {}; });
    await expect(applyPasteImports(request, ["nc.a.Foo"])).rejects.toThrow("未应用");
    expect(model.pushEditOperations).not.toHaveBeenCalled();
  });
});
