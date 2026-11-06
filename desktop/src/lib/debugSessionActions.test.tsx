// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (data: unknown) => void>() }));
vi.mock("./tauri", () => ({ invoke: mock.invoke, listen: async (event: string, callback: (data: unknown) => void) => { mock.events.set(event, callback); return () => {}; } }));
vi.mock("./debugSync", () => ({ applyBreakpointEvent: vi.fn(), resetBreakpointSync: vi.fn(), startBreakpointSync: vi.fn(), syncBreakpoints: vi.fn(async () => {}) }));
import { getDebugSnapshot, resumeDebug, stepDebug, useDebugSnapshot } from "./debugSession";
import { debugStart } from "./debug";
import { clearCompletedOperations, getOperations } from "./operations";
import { updateWorkbenchLayout } from "./workbenchLayout";
import { getSession, setSession } from "./workspaceSession";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
function Probe() { useDebugSnapshot(); return null; }
const emit = async (event: string, data: unknown) => { await act(async () => mock.events.get(event)?.(data)); };
const pause = async () => { await emit("debug-status", { state: "attached", module: "gl" }); await emit("debug-event", { event: "stopped", body: { threadId: 7 } }); };
beforeAll(async () => {
  mock.invoke.mockImplementation(async cmd => cmd === "debug_status" ? { state: "stopped" } : {});
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<Probe />));
});
afterAll(async () => { await act(async () => root.unmount()); host.remove(); });
describe("调试动作失败恢复", () => {
  it("锁定布局后新暂停仅更新目标和暂停指示，不抢工具页签", async () => {
    updateWorkbenchLayout({ locked: true });
    setSession({ panelTab: "build", panelOpen: false });
    const seq = getDebugSnapshot().stopSeq;
    await emit("debug-event", { event: "stopped", body: {} });
    expect(getDebugSnapshot()).toMatchObject({ paused: true, stopSeq: seq + 1 });
    expect(getSession()).toMatchObject({ panelTab: "build", panelOpen: false });
    updateWorkbenchLayout({ locked: false });
    await emit("debug-event", { event: "stopped", body: {} });
    expect(getSession()).toMatchObject({ panelTab: "debug", panelOpen: true });
  });
  it("附加返回未建立时失败，不能显示附加成功", async () => {
    mock.invoke.mockResolvedValueOnce({ state: "stopped", message: "JDWP不可用" });
    await expect(debugStart()).rejects.toThrow("JDWP不可用");
    expect(getOperations().find(o => o.key === "debug.attach:server")?.state).toBe("failed");
  });
  it("继续/步进请求失败恢复可重试的暂停位置", async () => {
    await pause(); clearCompletedOperations();
    mock.invoke.mockRejectedValueOnce(new Error("continue failed"));
    await act(async () => resumeDebug());
    expect(getDebugSnapshot()).toMatchObject({ paused: true, threadId: 7, error: "continue failed" });
    mock.invoke.mockRejectedValueOnce(new Error("step failed"));
    await act(async () => stepDebug("over"));
    expect(getDebugSnapshot()).toMatchObject({ paused: true, threadId: 7, error: "step failed" });
  });
  it("请求中收到继续事件后不恢复旧暂停位置", async () => {
    await pause();
    let fail!: (error: Error) => void;
    mock.invoke.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    await act(async () => { void stepDebug("over"); });
    await emit("debug-event", { event: "continued", body: {} });
    await act(async () => { fail(new Error("late failure")); });
    expect(getDebugSnapshot().paused).toBe(false);
  });
  it("新暂停清除旧栈后重新读取线程，不能一直显示读取线程", async () => {
    mock.invoke.mockImplementation(async cmd => cmd === "debug_threads" ? { threads: [{ id: 7, name: "main" }] } : {});
    await pause();
    expect(getDebugSnapshot().threads).toEqual([{ id: 7, name: "main" }]);
    mock.invoke.mockImplementation(async cmd => cmd === "debug_status" ? { state: "stopped" } : {});
  });
});
