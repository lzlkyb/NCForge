import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mock.invoke }));
import { serverStart, serverStop } from "./server";
import { cancelOperation, clearCompletedOperations, getOperations } from "./operations";
const task = () => getOperations().find(o => o.key === "service.start")!;
beforeEach(() => { vi.useFakeTimers(); mock.invoke.mockReset(); clearCompletedOperations(); });
afterEach(() => { vi.useRealTimers(); });
describe("服务启动任务真实状态", () => {
  it("启动请求返回后保持运行，只有监听就绪才结束；同一期间不能重复启动", async () => {
    let running = false;
    mock.invoke.mockImplementation(async cmd => cmd === "server_status" ? { state: running ? "running" : "starting", port: 80 } : undefined);
    await serverStart();
    expect(task().state).toBe("running");
    await expect(serverStart()).rejects.toThrow("服务正在启动");
    expect(mock.invoke.mock.calls.filter(c => c[0] === "server_start")).toHaveLength(1);
    running = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(task()).toMatchObject({ state: "success", detail: "监听端口 80 已就绪" });
  });
  it("停止请求不能立刻当作取消完成，后端状态停止后才结束", async () => {
    let stopped = false;
    mock.invoke.mockImplementation(async cmd => cmd === "server_status" ? { state: stopped ? "stopped" : "starting", port: 80, reason: null } : "cancelling");
    await serverStart();
    await cancelOperation(task().id);
    expect(task().state).toBe("cancelling");
    stopped = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(task().state).toBe("cancelled");
  });
  it("服务按钮停止正在启动的服务也以取消结束，不报启动失败", async () => {
    let stopped = false;
    mock.invoke.mockImplementation(async cmd => cmd === "server_status" ? { state: stopped ? "stopped" : "starting", port: 80 } : "stopped");
    await serverStart();
    await serverStop(); stopped = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(task().state).toBe("cancelled");
  });
  it("进程退出或无法读取状态不误报就绪", async () => {
    mock.invoke.mockImplementation(async cmd => cmd === "server_status" ? { state: "stopped", port: 80, reason: "缺少启动类" } : undefined);
    await serverStart(); await Promise.resolve();
    expect(task()).toMatchObject({ state: "failed", detail: "缺少启动类" });
    mock.invoke.mockImplementation(async cmd => { if (cmd === "server_status") throw new Error("IPC disconnected"); });
    await serverStart(); await Promise.resolve();
    expect(getOperations()[getOperations().length - 1]).toMatchObject({ state: "failed" });
  });
});
