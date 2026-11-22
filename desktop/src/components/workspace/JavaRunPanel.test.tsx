// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JavaRunPanel } from "./JavaRunPanel";
import type { JavaRunResult } from "../../lib/javaRun";
import type { JavaRunConfig } from "../../lib/javaRunConfig";

const mocks = vi.hoisted(() => ({
  snapshot: { running: false, root: "D:/ws", config: { mode: "test", path: "D:/ws/PriceTest.java", classes: "nc.demo.PriceTest", args: "", extraClasspath: "" } as JavaRunConfig, log: [] as string[], error: "", result: null as JavaRunResult | null, pid: null as number | null },
  invoke: vi.fn(), run: vi.fn(), configure: vi.fn(), current: vi.fn(), cancel: vi.fn(), rerun: vi.fn(), search: vi.fn(), open: vi.fn(), error: vi.fn(),
}));
vi.mock("../../lib/javaRun", () => ({
  useJavaRunSnapshot: () => mocks.snapshot,
  runJava: mocks.run, configureJavaRun: mocks.configure, configureRunFromEditor: mocks.current,
  cancelJavaRun: mocks.cancel, rerunFailed: mocks.rerun,
}));
vi.mock("../../lib/workspaceSession", () => ({ useWorkspaceSelector: (selector: (session: { root: string; activePath: string }) => unknown) => selector({ root: "D:/ws", activePath: "D:/ws/PriceTest.java" }) }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/typeSearch", () => ({ searchTypes: mocks.search }));
vi.mock("../../lib/openFileRequest", () => ({ requestOpenFile: mocks.open }));
vi.mock("../../lib/errorToast", () => ({ errorToast: mocks.error }));
vi.mock("./JavaDiagnosticTools", () => ({ JavaDiagnosticTools: () => <div>JVM 诊断</div> }));
// 面板里的启动配置下拉要读启动配置库；这里只桩掉 IPC（其余纯函数保持真实），
// 否则共用 invoke mock 的用例会把 java_run_discover 的返回值喂给 launch_config_list。
vi.mock("../../lib/launchConfigs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launchConfigs")>()),
  listLaunchConfigs: () => Promise.resolve({ configs: [], notes: [] }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const button = (text: string) => [...host.querySelectorAll("button")].find(element => element.textContent === text)!;
// 面板里的启动配置下拉走 react-query（launch_config_list），渲染要带 Provider；
// IPC 已被上面的 tauri mock 接住，返回 undefined 时按「没有配置」渲染。
const render = async () => { await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><JavaRunPanel /></QueryClientProvider>)); };
const click = async (text: string) => { await act(async () => button(text).click()); };
beforeEach(() => {
  vi.clearAllMocks(); mocks.snapshot.running = false; mocks.snapshot.result = null;
  mocks.cancel.mockResolvedValue(undefined); mocks.invoke.mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe("Java run panel actions", () => {
  it("routes run, debug and coverage to the same complete configuration", async () => {
    await render(); await click("运行测试"); expect(mocks.run).toHaveBeenLastCalledWith(mocks.snapshot.config);
    await click("调试"); expect(mocks.run).toHaveBeenLastCalledWith(mocks.snapshot.config, true);
    await click("覆盖率"); expect(mocks.run).toHaveBeenLastCalledWith(mocks.snapshot.config, false, true);
  });
  it("replaces launch actions with cancellation while a process runs", async () => {
    mocks.snapshot.running = true; await render();
    expect(host.querySelector("textarea")!.disabled).toBe(true);
    expect(button("运行测试")).toBeUndefined(); await click("停止运行"); expect(mocks.cancel).toHaveBeenCalledOnce();
  });
  it("discovers module tests and retains exact fully qualified class names", async () => {
    mocks.invoke.mockResolvedValue([{ className: "nc.demo.PriceTest", path: "D:/ws/PriceTest.java", methods: ["testPrice"] }, { className: "nc.demo.OtherTest", path: "D:/ws/OtherTest.java", methods: [] }]);
    await render(); await click("查找当前模块测试");
    expect(mocks.invoke).toHaveBeenCalledWith("java_run_discover", { path: "D:/ws/PriceTest.java" });
    expect(mocks.configure).toHaveBeenCalledWith({ ...mocks.snapshot.config, classes: "nc.demo.PriceTest\nnc.demo.OtherTest" });
  });
  it("shows real failure counts, reruns failures and opens the generated report", async () => {
    mocks.snapshot.result = { id: "run-1", ok: false, cancelled: false, exitCode: 1, durationMs: 123, tests: [{ target: "nc.demo.PriceTest", count: 3, failures: 1, ignored: 1 }], failures: [{ className: "nc.demo.PriceTest", method: "testPrice", trace: "at nc.demo.PriceTest.testPrice(PriceTest.java:42)" }], report: "D:/private/java-runs/run-1/coverage/index.html", resultsTruncated: false };
    await render(); expect(host.textContent).toContain("执行 3 · 失败 1 · 跳过 1");
    await click("重跑失败项"); expect(mocks.rerun).toHaveBeenCalledOnce();
    await click("打开覆盖率报告"); expect(mocks.invoke).toHaveBeenCalledWith("java_run_open_report", { path: mocks.snapshot.result.report });
  });
  it("opens an exact failing source line and requires a choice for duplicate sources", async () => {
    mocks.snapshot.result = { id: "run-1", ok: false, cancelled: false, exitCode: 1, durationMs: 123, tests: [], failures: [{ className: "nc.demo.PriceTest", method: "testPrice", trace: "at nc.demo.PriceTest.testPrice(PriceTest.java:42)" }], report: null, resultsTruncated: false };
    mocks.search.mockResolvedValue({ workspace: [{ name: "nc.demo.PriceTest", file: "D:/ws/PriceTest.java" }, { name: "other.PriceTest", file: "D:/ws/Other.java" }] });
    await render(); await click("打开失败位置"); expect(mocks.open).toHaveBeenCalledWith({ path: "D:/ws/PriceTest.java", line: 42 });
    mocks.open.mockClear(); mocks.search.mockResolvedValue({ workspace: [{ name: "nc.demo.PriceTest", file: "D:/ws/PriceTest.java" }, { name: "nc.demo.PriceTest", file: "D:/ws/linked/PriceTest.java" }] });
    await click("打开失败位置"); expect(mocks.open).not.toHaveBeenCalled(); expect(host.textContent).toContain("有多个源码来源，请选择");
    await click("D:/ws/linked/PriceTest.java:42"); expect(mocks.open).toHaveBeenCalledWith({ path: "D:/ws/linked/PriceTest.java", line: 42 });
  });
  it("opens nested failures through an exact enclosing type and stack source filename", async () => {
    mocks.snapshot.result = { id: "run-1", ok: false, cancelled: false, exitCode: 1, durationMs: 1, tests: [], failures: [{ className: "nc.demo.Outer$Inner", method: "test", trace: "at nc.demo.Outer$Inner.test(Outer.java:24)" }], report: null, resultsTruncated: false };
    mocks.search.mockResolvedValue({ workspace: [{ name: "nc.demo.Outer", file: "D:/ws/Outer.java" }, { name: "other.Outer", file: "D:/ws/wrong/Outer.java" }, { name: "nc.demo.Inner", file: "D:/ws/Inner.java" }] });
    await render(); await click("打开失败位置");
    expect(mocks.open).toHaveBeenCalledWith({ path: "D:/ws/Outer.java", line: 24 });
    expect(mocks.search).toHaveBeenCalledWith("nc.demo.Outer", 100);
  });
  it("refuses an enclosing-type hit when the failure stack names a different source file", async () => {
    mocks.snapshot.result = { id: "run-1", ok: false, cancelled: false, exitCode: 1, durationMs: 1, tests: [], failures: [{ className: "nc.demo.Outer$Inner", method: "test", trace: "at nc.demo.Outer$Inner.test(Another.java:24)" }], report: null, resultsTruncated: false };
    mocks.search.mockResolvedValue({ workspace: [{ name: "nc.demo.Outer", file: "D:/ws/Outer.java" }] });
    await render(); await click("打开失败位置");
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.error).toHaveBeenCalled();
  });
  it("keeps literal dollar signs when the exact top-level source type exists", async () => {
    mocks.snapshot.result = { id: "run-1", ok: false, cancelled: false, exitCode: 1, durationMs: 1, tests: [], failures: [{ className: "nc.demo.Price$Test", method: "test", trace: "at nc.demo.Price$Test.test(Price$Test.java:8)" }], report: null, resultsTruncated: false };
    mocks.search.mockResolvedValue({ workspace: [{ name: "nc.demo.Price$Test", file: "D:/ws/Price$Test.java" }, { name: "nc.demo.Price", file: "D:/ws/Price.java" }] });
    await render(); await click("打开失败位置");
    expect(mocks.open).toHaveBeenCalledWith({ path: "D:/ws/Price$Test.java", line: 8 });
  });
  it("retains the exact nested failure line when its method name contains a dollar sign", async () => {
    mocks.snapshot.result = { id: "run-1", ok: false, cancelled: false, exitCode: 1, durationMs: 1, tests: [], failures: [{ className: "nc.demo.Outer$Inner", method: "test$Case", trace: "at nc.demo.Outer$Inner.test$Case(Outer.java:24)" }], report: null, resultsTruncated: false };
    mocks.search.mockResolvedValue({ workspace: [{ name: "nc.demo.Outer", file: "D:/ws/Outer.java" }, { name: "nc.demo.Outer", file: "D:/ws/Other.java" }] });
    await render(); await click("打开失败位置");
    expect(mocks.open).toHaveBeenCalledWith({ path: "D:/ws/Outer.java", line: 24 });
    expect(host.textContent).not.toContain("有多个源码来源");
  });
  it("uses a real source filename containing Chinese characters and parentheses", async () => {
    mocks.snapshot.result = { id: "run-1", ok: false, cancelled: false, exitCode: 1, durationMs: 1, tests: [], failures: [{ className: "nc.demo.OtherTest$Inner", method: "test$Case", trace: "at nc.demo.OtherTest$Inner.test$Case(测试套件 (A).java:24)" }], report: null, resultsTruncated: false };
    mocks.search.mockResolvedValue({ workspace: [{ name: "nc.demo.OtherTest", file: "D:/ws/测试套件 (A).java" }, { name: "nc.demo.OtherTest", file: "D:/ws/OtherTest.java" }] });
    await render(); await click("打开失败位置");
    expect(mocks.open).toHaveBeenCalledWith({ path: "D:/ws/测试套件 (A).java", line: 24 });
  });
});
