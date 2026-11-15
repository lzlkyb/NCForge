import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ version: 1, epoch: 1, capability: 1, group: "left", activePath: "D:/project/module/A.java", request: vi.fn(), navigate: vi.fn(async (..._args: unknown[]) => true), model: null as unknown }));
vi.mock("./monacoSetup", () => ({ monaco: { editor: { getModel: () => mocks.model }, Uri: { parse: (uri: string) => uri, file: (path: string) => ({ toString: () => `file:///${path}` }) } } }));
vi.mock("./editorActions", () => ({ currentModel: () => mocks.model, cursorAt: () => ({ line: 1, column: 1 }) }));
vi.mock("./editorStore", () => ({ pathOfModel: () => "D:/project/module/A.java", getText: () => "" }));
vi.mock("./workspaceEpoch", () => ({ workspaceEpoch: () => mocks.epoch }));
vi.mock("./langProviderContext", () => ({ context: async () => ({ path: "D:/project/module/A.java", position: { line: 0, character: 0 } }) }));
vi.mock("./lang", () => ({ getLangView: () => ({ state: "ready" }), langRequest: (...args: unknown[]) => mocks.request(...args), langCapabilityEpoch: () => mocks.capability, navigate: (...args: unknown[]) => mocks.navigate(...args), loadJdtSource: vi.fn(), moduleOfPath: () => "module" }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: "D:/project", activePath: mocks.activePath, tabs: [], editorGroups: { focused: mocks.group } }) }));
vi.mock("./codeRelations", () => ({ selectRelationView: vi.fn() }));
vi.mock("./upm", () => ({ upmLookup: vi.fn(async () => []) }));
import { captureNavigation, closeNavigation, getNavigationState, getNavigationResult, openNavigation, chooseNavigationTarget } from "./navigationService";
const target = (uri: string) => ({ uri, range: { start: { line: 8, character: 5 }, end: { line: 8, character: 10 } } });
beforeEach(() => {
  closeNavigation(); mocks.version = mocks.epoch = mocks.capability = 1; mocks.group = "left"; mocks.activePath = "D:/project/module/A.java"; mocks.request.mockReset(); mocks.navigate.mockClear();
  mocks.model = { uri: { toString: () => "file:///D:/project/module/A.java" }, getVersionId: () => mocks.version, isDisposed: () => false, getValue: () => "package module; class A {}" };
});
describe("navigation owns its originating document", () => {
  it("opens one implementation directly and keeps multiple implementations available for selection", async () => {
    mocks.request.mockResolvedValueOnce([target("file:///D:/project/module/B.java")]);
    await openNavigation("implementation");
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ path: "D:\\project\\module\\B.java", line: 9, column: 6 }));
    mocks.navigate.mockClear(); mocks.request.mockResolvedValueOnce([target("file:///D:/one/B.java"), target("file:///D:/two/B.java")]);
    await openNavigation("implementation");
    expect(mocks.navigate).not.toHaveBeenCalled(); expect(getNavigationState().items).toHaveLength(2); expect(getNavigationState().open).toBe(true);
  });
  it("does not navigate using a response from a document edited while the query was running", async () => {
    let answer!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const operation = openNavigation("implementation"); await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    mocks.version++; answer([target("file:///D:/old/B.java")]); await operation;
    expect(mocks.navigate).not.toHaveBeenCalled(); expect(getNavigationState().loading).toBe(false); expect(getNavigationState().error).toContain("发生变化");
  });
  it("rejects hover actions retained from a previous workspace or language-service generation", async () => {
    const intent = captureNavigation(mocks.model as Parameters<typeof captureNavigation>[0], 1, 1); mocks.capability++;
    await openNavigation("super", intent); expect(mocks.request).not.toHaveBeenCalled(); expect(getNavigationState().error).toContain("重新执行");
  });
  it("a slow target open cannot close a newer result chooser", async () => {
    mocks.request.mockResolvedValue([target("file:///D:/one/B.java"), target("file:///D:/two/B.java")]);
    await openNavigation("implementation");
    let finish!: (value: boolean) => void;
    mocks.navigate.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const operation = chooseNavigationTarget(getNavigationState().items[0]);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await openNavigation("type", undefined, true);
    finish(true); await operation;
    expect(getNavigationState()).toMatchObject({ kind: "type", open: true });
  });
  it("discards a query if the user changes editor groups while it is running", async () => {
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const operation = openNavigation("implementation"); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    mocks.group = "right"; finish([target("file:///D:/one/B.java")]); await operation;
    expect(mocks.navigate).not.toHaveBeenCalled(); expect(getNavigationState().error).toContain("活动编辑器");
  });
  it("discards a slow response after switching files in the same group", async () => {
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const operation = openNavigation("implementation"); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    mocks.activePath = "D:/project/module/Other.java";
    finish([target("file:///D:/old/B.java")]); await operation;
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(getNavigationState()).toMatchObject({ loading: false });
    expect(getNavigationState().error).toContain("发生变化");
  });
  it("assigns background actions to the group focused when clicked", async () => {
    const intent = captureNavigation(mocks.model as Parameters<typeof captureNavigation>[0], 1, 1);
    delete intent.group;
    mocks.group = "right";
    mocks.activePath = "d:\\project\\module\\A.java";
    mocks.request.mockResolvedValueOnce([target("file:///D:/one/B.java")]);
    await openNavigation("implementation", intent);
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });
  it("keeps successful relation results explicitly openable from another file or group", async () => {
    mocks.request.mockResolvedValueOnce({ references: [target("file:///D:/one/B.java")] });
    await openNavigation("references");
    const result = getNavigationResult("references");
    mocks.group = "right"; mocks.activePath = "D:/project/module/Other.java";
    await chooseNavigationTarget(result.items[0], false, result.intent);
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });
  it("retains the prior successful references on RPC failure, but clears them for a real zero result", async () => {
    mocks.request.mockResolvedValueOnce({ references: [target("file:///D:/one/B.java")] });
    await openNavigation("references"); expect(getNavigationResult("references").items).toHaveLength(1);
    mocks.request.mockRejectedValue(new Error("服务中断"));
    await openNavigation("references"); expect(getNavigationResult("references").items).toHaveLength(1); expect(getNavigationResult("references").error).toContain("服务中断");
    mocks.request.mockResolvedValue({ references: [] });
    await openNavigation("references"); expect(getNavigationResult("references").items).toEqual([]); expect(getNavigationResult("references").error).toBe("");
  });
});
