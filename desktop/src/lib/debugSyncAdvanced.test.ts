import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Breakpoint } from "./breakpoints";
const mocks = vi.hoisted(() => ({ items: [{ path: "D:/ws/A.java", line: 3, enabled: true }] as Breakpoint[], setBreakpoints: vi.fn() }));
vi.mock("./debug", () => ({ DEBUG_TARGETS: ["server", "client", "remote"], debugSetBreakpoints: mocks.setBreakpoints }));
vi.mock("./breakpoints", async () => ({ ...await vi.importActual<typeof import("./breakpoints")>("./breakpoints"), getBreakpoints: () => mocks.items, subscribeBreakpoints: () => () => {} }));
import { startBreakpointSync, installTemporaryBreakpoint, clearTemporaryBreakpoint, resetBreakpointSync } from "./debugSync";
beforeEach(() => { resetBreakpointSync(); mocks.setBreakpoints.mockClear(); mocks.items = [{ path: "D:/ws/A.java", line: 3, enabled: true }]; });
describe("run-to-cursor breakpoint cleanup", () => {
  it("adds only a target-local temporary breakpoint then restores the user's list", async () => {
    mocks.setBreakpoints.mockImplementation((_target, path, list: { line: number }[]) => Promise.resolve({ breakpoints: list.map(item => ({ line: item.line, verified: true, source: { path } })) }));
    startBreakpointSync(() => ["server"]);
    await installTemporaryBreakpoint("server", "D:/ws/A.java", 12);
    expect(mocks.setBreakpoints).toHaveBeenLastCalledWith("server", "D:/ws/A.java", [{ line: 3 }, { line: 12 }]);
    expect(mocks.items).toEqual([{ path: "D:/ws/A.java", line: 3, enabled: true }]);
    await clearTemporaryBreakpoint("server");
    expect(mocks.setBreakpoints).toHaveBeenLastCalledWith("server", "D:/ws/A.java", [{ line: 3 }]);
  });
  it("temporarily overrides a conditional logpoint at the cursor and restores every user rule", async () => {
    const original = { path: "D:/ws/A.java", line: 12, enabled: true, condition: "false", hitCondition: "5", logMessage: "only log" };
    mocks.items = [original];
    mocks.setBreakpoints.mockImplementation((_target, path, list: { line: number }[]) => Promise.resolve({ breakpoints: list.map(item => ({ line: item.line, verified: true, source: { path } })) }));
    startBreakpointSync(() => ["server"]);
    await installTemporaryBreakpoint("server", original.path, 12);
    expect(mocks.setBreakpoints).toHaveBeenLastCalledWith("server", original.path, [{ line: 12 }]);
    expect(mocks.items).toEqual([original]);
    await clearTemporaryBreakpoint("server");
    expect(mocks.setBreakpoints).toHaveBeenLastCalledWith("server", original.path, [{ line: 12, condition: "false", hitCondition: "5", logMessage: "only log" }]);
  });
});
