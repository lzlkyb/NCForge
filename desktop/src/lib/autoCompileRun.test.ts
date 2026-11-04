// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, compile: vi.fn(), toast: vi.fn() }));
vi.mock("./workspaceSession", () => ({ getSession: () => mocks.state, setSession: (patch: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(patch)) mocks.state[key] = typeof value === "function" ? value(mocks.state[key]) : value;
} }));
vi.mock("./appConfig", () => ({ isAutoCompileEnabled: async () => true }));
vi.mock("./compile", () => ({ compileFile: mocks.compile, isCompileCancelled: (e: unknown) => String(e).includes("CANCELLED") }));
vi.mock("./autoCompileQueue", () => ({ requeueAutoCompile: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
import { runAutoCompile } from "./autoCompileRun";
beforeEach(() => {
  mocks.compile.mockReset(); mocks.toast.mockReset();
  mocks.state = { root: "D:/p", compiling: false, panelOpen: false, panelTab: "svc", compileLog: ["manual log"], compileResult: null };
});
describe("自动编译组件缺失", () => {
  it("保留下载引导，不抢面板也不清手动日志，成功后清除", async () => {
    mocks.compile.mockRejectedValue("找不到 Java 编译器组件（ecj）");
    await runAutoCompile(["D:/p/module/src/A.java"]);
    expect(mocks.state.compileResourceMissing).toBe(true);
    expect(mocks.state.panelOpen).toBe(false); expect(mocks.state.panelTab).toBe("svc");
    expect(mocks.state.compileLog).toEqual(["manual log"]);
    mocks.compile.mockResolvedValue({ status: "compiled", result: { ok: true, problems: [], sourceCount: 1, errorCount: 0, warningCount: 0, diagnostics: [] } });
    await runAutoCompile(["D:/p/module/src/A.java"]);
    expect(mocks.state.compileResourceMissing).toBe(false);
  });
  it("切工程后的旧错误不写入新工程", async () => {
    mocks.compile.mockImplementation(async () => { mocks.state.root = "D:/new"; throw "找不到 Java 编译器组件（ecj）"; });
    await runAutoCompile(["D:/p/module/src/A.java"]);
    expect(mocks.state.compileResourceMissing).toBeUndefined(); expect(mocks.toast).not.toHaveBeenCalled();
  });
});
