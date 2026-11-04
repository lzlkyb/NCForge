// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, all: vi.fn(), module: vi.fn(), cancel: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/workspaceSession", () => ({
  getSession: () => mocks.state,
  useWorkspaceSelector: (select: (state: Record<string, unknown>) => unknown) => select(mocks.state),
  setSession: (patch: Record<string, unknown>) => { for (const [key, value] of Object.entries(patch)) mocks.state[key] = typeof value === "function" ? value(mocks.state[key]) : value; },
}));
vi.mock("../lib/compile", async importOriginal => {
  const actual = await importOriginal<typeof import("../lib/compile")>();
  return { ...actual, compileAllModules: mocks.all, compileModule: mocks.module, compileCancel: mocks.cancel, onCompileLog: () => Promise.resolve(() => {}) };
});
vi.mock("../lib/commandRegistry", () => ({ registerCommands: () => () => {} }));
vi.mock("../lib/ncTasks", () => ({ BUILTIN_TASKS: [], buildNcTaskRuntime: () => ({}), runTask: vi.fn(), setTaskRuntime: vi.fn() }));
vi.mock("../lib/autoCompileQueue", () => ({ setAutoCompileRunner: vi.fn() }));
vi.mock("../lib/autoCompileRun", () => ({ runAutoCompile: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
import { useModuleCompile } from "./useModuleCompile";
import { getOperations, clearCompletedOperations, cancelOperation } from "../lib/operations";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, api: ReturnType<typeof useModuleCompile>;
function Harness() { api = useModuleCompile(); return null; }
const last = () => { const list = getOperations(); return list[list.length - 1]; };
const RESULT = { ok: true, durationMs: 1, sourceCount: 1, errorCount: 0, warningCount: 0, problems: [], jarCount: 0, rounds: 1, outDir: "classes", diagnostics: [] };
beforeEach(async () => {
  clearCompletedOperations(); mocks.all.mockReset(); mocks.module.mockReset(); mocks.cancel.mockReset(); mocks.toast.mockReset();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.state = { root: "D:/p", activePath: "D:/p/X.java", tabs: [{ path: "D:/p/X.java", dirty: false }], compiling: false, compileResult: null, compileLog: [] };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearCompletedOperations(); });

describe("手动编译任务", () => {
  it("缺 ecj 保留下载引导，新一轮成功后清除", async () => {
    mocks.all.mockRejectedValue(new Error("找不到 Java 编译器组件（ecj）"));
    expect(await api.compileAll()).toBe(false);
    expect(mocks.state.compileResourceMissing).toBe(true);
    expect(String(mocks.state.compileLog)).toContain("找不到 Java 编译器组件");
    mocks.all.mockResolvedValue(RESULT);
    expect(await api.compileAll()).toBe(true);
    expect(mocks.state.compileResourceMissing).toBe(false);
  });
  it("同帧重复点击只启动一次编译", async () => {
    let done!: (value: typeof RESULT) => void;
    mocks.all.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const first = api.compileAll();
    expect(await api.compileAll()).toBe(false); expect(mocks.all).toHaveBeenCalledTimes(1);
    done(RESULT); expect(await first).toBe(true); expect(last().state).toBe("success");
  });
  it("后台自动编译已运行时不清空日志或创建第二轮任务", async () => {
    mocks.state.compiling = true; mocks.state.compileLog = ["existing-auto-log"];
    expect(await api.compileAll()).toBe(false);
    expect(mocks.all).not.toHaveBeenCalled(); expect(mocks.state.compileLog).toEqual(["existing-auto-log"]); expect(getOperations()).toHaveLength(0);
  });
  it("后端 ok=false 即使没有诊断错误也不能继续任务链", async () => {
    mocks.all.mockResolvedValue({ ...RESULT, ok: false });
    expect(await api.compileAll()).toBe(false); expect(last().state).toBe("failed");
  });
  it("停止请求保持进行状态，原编译确认 CANCELLED 才结束", async () => {
    let fail!: (error: unknown) => void;
    mocks.all.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const running = api.compileAll(); await cancelOperation(last().id);
    expect(last().state).toBe("cancelling"); expect(mocks.state.compiling).toBe(true);
    fail(new Error("CANCELLED: stopped")); expect(await running).toBe(false);
    expect(last().state).toBe("cancelled"); expect(mocks.state.compiling).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith("已取消编译", "info");
  });
  it("切换工程后不把旧诊断写进新工程", async () => {
    let done!: (value: typeof RESULT) => void;
    mocks.all.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const running = api.compileAll(); mocks.state.root = "D:/other";
    done(RESULT); expect(await running).toBe(false);
    expect(mocks.state.compileResult).toBeNull(); expect(last().state).toBe("cancelled");
  });
});
