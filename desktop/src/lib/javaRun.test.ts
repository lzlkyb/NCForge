// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ source: null as any, toast: vi.fn(), invoke: vi.fn(), listen: vi.fn(), attach: vi.fn(), remote: { state: "stopped", busy: null } }));
vi.mock("./tauri", () => ({ invoke: h.invoke, listen: h.listen }));
vi.mock("./debugSession", () => ({ attachDebugger: h.attach, getDebugSnapshot: () => ({ targets: { remote: h.remote } }) }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: "D:/project", tabs: [] }) }));
vi.mock("./workspaceEpoch", () => ({ workspaceEpoch: () => 1 }));
vi.mock("./editorActions", () => ({ editorSnapshot: () => h.source }));
vi.mock("../components/ui/toast", () => ({ toast: h.toast }));
import { configureJavaRun, configureRunFromEditor, getJavaRunSnapshot, runJava } from "./javaRun";
import { withJavaRunsStopped } from "./javaRunLifecycle";
import { emptyJavaRunConfig } from "./javaRunConfig";
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); h.remote = { state: "stopped", busy: null }; h.attach.mockResolvedValue(undefined); h.listen.mockResolvedValue(() => {}); configureJavaRun(emptyJavaRunConfig()); });
describe("run commands use the actual editor cursor", () => {
  it("forwards the cursor column when two methods share a source line", async () => {
    const text = "package demo; class A { void first() {} void second() {} }";
    h.source = { path: "D:/project/A.java", isJava: true, text, line: 1, column: text.indexOf("second") + 1 };
    await configureRunFromEditor("test", true);
    expect(getJavaRunSnapshot().config.classes).toBe("demo.A#second");
    expect(h.toast).not.toHaveBeenCalled();
  });
  it("uses a nested class binary name when configuring a class run", async () => {
    const text = "package demo; class A { class B { void run() {} } }";
    h.source = { path: "D:/project/A.java", isJava: true, text, line: 1, column: text.indexOf("run") + 1 };
    await configureRunFromEditor("main");
    expect(getJavaRunSnapshot().config.classes).toBe("demo.A$B");
  });
});
describe("workspace Java run lifecycle", () => {
  const config = { ...emptyJavaRunConfig(), path: "D:/project/A.java", classes: "demo.A" };
  for (const mode of ["main", "test", "debug"] as const) {
    it(`cancels and waits for an already started ${mode} task`, async () => {
      let done!: (value: any) => void, started!: (event: any) => void;
      h.listen.mockImplementation(async (name: string, callback: any) => { if (name === "java-run-started") started = callback; return () => {}; });
      h.invoke.mockImplementation((name: string) => name === "java_run" ? new Promise(resolve => { done = resolve; }) : Promise.resolve());
      const running = runJava({ ...config, mode: mode === "test" ? "test" : "main" }, mode === "debug");
      await vi.waitFor(() => expect(done).toBeDefined());
      const id = getJavaRunSnapshot().id!;
      started({ id, pid: 1234, debugPort: mode === "debug" ? 4567 : null });
      let switched = false;
      const switching = withJavaRunsStopped(async () => { switched = true; });
      await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith("java_run_cancel", { id }));
      expect(switched).toBe(false); expect(getJavaRunSnapshot().running).toBe(true);
      done({ id, ok: false, cancelled: true, exitCode: null, durationMs: 1, tests: [], failures: [], report: null, resultsTruncated: false });
      await running; await switching;
      expect(switched).toBe(true); expect(getJavaRunSnapshot().running).toBe(false);
      expect(h.attach).toHaveBeenCalledTimes(mode === "debug" ? 1 : 0);
    });
  }
  it("does not launch a task cancelled while event listeners are still connecting", async () => {
    let connected!: (value: () => void) => void;
    h.listen.mockImplementationOnce(() => new Promise(resolve => { connected = resolve; }));
    h.invoke.mockResolvedValue(undefined);
    const running = runJava(config);
    const switching = withJavaRunsStopped(async () => {});
    connected(() => {}); await running; await switching;
    expect(h.invoke.mock.calls.some(([name]) => name === "java_run")).toBe(false);
    expect(getJavaRunSnapshot().running).toBe(false);
  });
  it("blocks a new Java run until the workspace switch has finished", async () => {
    let finish!: () => void;
    const switching = withJavaRunsStopped(() => new Promise<void>(resolve => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    await runJava(config);
    expect(h.invoke).not.toHaveBeenCalled();
    finish(); await switching;
  });
});
