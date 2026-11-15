import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  version: 1, epoch: 1, capability: 1, disposed: false, name: "Original",
  context: vi.fn(), request: vi.fn(), begin: vi.fn(), finish: vi.fn(), navigate: vi.fn(), toast: vi.fn(),
}));
vi.mock("./editorActions", () => ({
  currentModel: () => ({ getVersionId: () => mocks.version, isDisposed: () => mocks.disposed }),
  cursorAt: () => ({ line: 5, column: 3 }),
}));
vi.mock("./langProviderContext", () => ({ context: (...args: unknown[]) => mocks.context(...args) }));
vi.mock("./operations", () => ({ beginOperation: (...args: unknown[]) => mocks.begin(...args) }));
vi.mock("./lang", () => ({ langReady: () => true, langCapabilityEpoch: () => mocks.capability, langRequest: (...args: unknown[]) => mocks.request(...args), navigate: (...args: unknown[]) => mocks.navigate(...args) }));
vi.mock("./workspaceEpoch", () => ({ workspaceEpoch: () => mocks.epoch }));
vi.mock("./codeRelations", () => ({ selectRelationView: vi.fn() }));
vi.mock("./keymap", () => ({ getKeymap: () => "idea", prettyChord: (value: string) => value }));
vi.mock("./keybindings", () => ({ getBindingOverride: () => null }));
vi.mock("../components/ui/toast", () => ({ toast: (...args: unknown[]) => mocks.toast(...args) }));
import { getCallState, openCallHierarchy, openCallItem } from "./callHierarchy";
import { getTypeState, openTypeHierarchy, openTypeEntry } from "./typeHierarchy";
const ctx = { path: "D:/demo/A.java", position: { line: 4, character: 2 } };
const callItem = (name = mocks.name) => ({ name, uri: "file:///D:/demo/A.java", selectionRange: { start: { line: 4, character: 2 } }, data: "server-only-data" });
const typeItem = (name = mocks.name) => ({ name, qualifiedName: `demo.${name}`, location: { uri: "file:///D:/demo/A.java", range: { start: { line: 4, character: 2 } } } });
const answer = (method: string) => {
  if (method === "textDocument/prepareCallHierarchy") return [callItem()];
  if (method === "callHierarchy/incomingCalls") return [{ from: callItem("Caller") }];
  if (method === "callHierarchy/outgoingCalls") return [{ to: callItem("Callee") }];
  return { type: typeItem(), supertypes: [typeItem("Parent")], subtypes: [typeItem("Child")] };
};
beforeEach(async () => {
  mocks.version = mocks.epoch = mocks.capability = 1; mocks.disposed = false; mocks.name = "Original";
  mocks.context.mockReset().mockResolvedValue(ctx);
  mocks.request.mockReset().mockImplementation(async (method: string) => answer(method));
  mocks.begin.mockReset().mockReturnValue({ finish: mocks.finish });
  mocks.finish.mockClear(); mocks.navigate.mockClear(); mocks.toast.mockClear();
  await openCallHierarchy(); await openTypeHierarchy();
  mocks.context.mockClear(); mocks.request.mockClear(); mocks.finish.mockClear();
});
describe.each([
  { name: "调用层级", open: openCallHierarchy, get: getCallState },
  { name: "类型层级", open: openTypeHierarchy, get: getTypeState },
])("$name保留结果与请求快照", ({ open, get }) => {
  it.each(["version", "epoch", "capability"] as const)("context等待期间%s变化时不发语义请求", async key => {
    mocks.context.mockImplementationOnce(async () => { mocks[key]++; return ctx; });
    await open();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(get()).toMatchObject({ root: { name: "Original" }, loading: false });
    expect(get().error).toContain("发生变化");
  });
  it("请求起步时工程已变化时不进入context", async () => {
    mocks.begin.mockImplementationOnce(() => { mocks.epoch++; return { finish: mocks.finish }; });
    await open(); expect(mocks.context).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
    expect(get().loading).toBe(false); expect(get().error).toContain("发生变化");
  });
  it.each(["version", "epoch", "capability"] as const)("RPC等待期间%s变化时旧结果不覆盖成功结果", async key => {
    mocks.request.mockImplementationOnce(async (method: string) => { mocks[key]++; mocks.name = "Stale"; return answer(method); });
    await open();
    expect(get()).toMatchObject({ root: { name: "Original" }, loading: false });
    expect(get().error).toContain("发生变化");
  });
  it("文档关闭后丢弃结果", async () => {
    mocks.request.mockImplementationOnce(async (method: string) => { mocks.disposed = true; return answer(method); });
    await open(); expect(get().root?.name).toBe("Original"); expect(get().error).toContain("发生变化");
  });
  it("加载与context失败保留上次成功结果并给出面板错误", async () => {
    let resolve!: (value: unknown) => void;
    mocks.context.mockImplementationOnce(() => new Promise(answer => { resolve = answer; }));
    const pending = open();
    expect(get()).toMatchObject({ loading: true, root: { name: "Original" } });
    resolve(null); await pending;
    expect(get()).toMatchObject({ loading: false, root: { name: "Original" } });
    expect(get().error).toContain("不在可分析");
  });
  it("真实请求错误保留结果且显示错误原因", async () => {
    mocks.request.mockRejectedValueOnce(new Error("服务超时")); await open();
    expect(get()).toMatchObject({ loading: false, root: { name: "Original" } });
    expect(get().error).toContain("服务超时");
  });
  it("光标没有可分析符号时保留上次成功结果", async () => {
    mocks.request.mockResolvedValueOnce(null); await open();
    expect(get()).toMatchObject({ loading: false, root: { name: "Original" } });
    expect(get().error).toContain("光标所在位置");
  });
  it.each([false, true])("后来的查询成功后旧请求%s完成不得覆盖它", async rejectOld => {
    let resolve!: (value: unknown) => void, reject!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const old = open(); await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    mocks.name = "Latest"; await open();
    if (rejectOld) reject(new Error("旧请求超时")); else resolve(answer("textDocument/prepareCallHierarchy"));
    await old;
    expect(get()).toMatchObject({ root: { name: "Latest" }, loading: false, error: null });
  });
});
describe("调用关系二段请求归属", () => {
  it.each(["callHierarchy/incomingCalls", "callHierarchy/outgoingCalls"])("%s等待期间语言服务换代后不发布层级", async stage => {
    mocks.request.mockImplementation(async (method: string) => {
      if (method === stage) mocks.capability++;
      return answer(method);
    });
    await openCallHierarchy(); expect(getCallState().root?.name).toBe("Original");
    expect(getCallState().incoming[0].name).toBe("Caller"); expect(getCallState().error).toContain("发生变化");
  });
  it("服务器原始item的data随incoming/outgoing原样传回", async () => {
    await openCallHierarchy();
    expect(mocks.request).toHaveBeenCalledWith("callHierarchy/incomingCalls", ctx.path, { item: callItem() }, 20000);
    expect(mocks.request).toHaveBeenCalledWith("callHierarchy/outgoingCalls", ctx.path, { item: callItem() }, 20000);
  });
  it("工程或文档变化后旧结果点击不会打开文件", () => {
    mocks.epoch++; openCallItem(getCallState().root!); openTypeEntry(getTypeState().root!);
    expect(mocks.navigate).not.toHaveBeenCalled(); expect(mocks.toast).toHaveBeenCalledTimes(2);
  });
  it("同一工程的成功结果仍可按精确行列打开", () => {
    openCallItem(getCallState().incoming[0]); openTypeEntry(getTypeState().supertypes[0]);
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: "file", path: "D:\\demo\\A.java", line: 5, column: 3 });
  });
});
