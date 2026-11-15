import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ paused: true, seq: 1, target: "server", root: "D:/ws", install: vi.fn(), clear: vi.fn(), invoke: vi.fn(), resume: vi.fn(), save: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke, listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("./debugSession", () => ({ getDebugSnapshot: () => ({ paused: mocks.paused, stopSeq: mocks.seq, target: mocks.target, threadId: 1 }), resumeDebug: mocks.resume }));
vi.mock("./debugSync", () => ({ installTemporaryBreakpoint: mocks.install, clearTemporaryBreakpoint: mocks.clear }));
vi.mock("./editorActions", () => ({ editorSnapshot: () => ({ path: "D:/ws/A.java", isJava: true, line: 12 }) }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: mocks.root }) }));
vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));
import { runToCursor, applyStepFilters } from "./debugAdvanced";
describe("advanced debug actions", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.paused = true; mocks.seq = 1; mocks.target = "server"; mocks.root = "D:/ws"; mocks.install.mockResolvedValue(undefined); vi.stubGlobal("localStorage", { setItem: mocks.save }); });
  afterEach(() => vi.unstubAllGlobals());
  it("installs a verified temporary breakpoint before continuing", async () => {
    mocks.resume.mockImplementation(() => { mocks.paused = false; });
    await runToCursor(); expect(mocks.install).toHaveBeenCalledWith("server", "D:/ws/A.java", 12); expect(mocks.resume).toHaveBeenCalledWith("server");
  });
  it("does not continue when the paused context changes while installing", async () => {
    mocks.install.mockImplementation(() => { mocks.seq = 2; return Promise.resolve(); });
    await runToCursor(); expect(mocks.resume).not.toHaveBeenCalled(); expect(mocks.clear).toHaveBeenCalledWith("server");
  });
  it("rejects invalid filter patterns before IPC", async () => {
    await expect(applyStepFilters("java.*;not valid")).rejects.toThrow("过滤规则"); expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("persists a delayed settings reply only under its original workspace", async () => {
    let finish!: () => void;
    mocks.invoke.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const applying = applyStepFilters("java.*,Helper");
    mocks.root = "D:/other-workspace"; finish(); await applying;
    expect(mocks.save).toHaveBeenCalledWith("ncforge-step-filters:D:/ws", "java.*,Helper");
    expect(mocks.save).not.toHaveBeenCalledWith("ncforge-step-filters:D:/other-workspace", expect.anything());
  });
});
