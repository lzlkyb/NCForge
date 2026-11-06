// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServiceActions } from "./useServiceActions";
const mocks = vi.hoisted(() => ({ toast: vi.fn(), root: "D:/project" }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../lib/workspaceSession", () => ({ useWorkspaceSelector: (selector: (s: { root: string }) => unknown) => selector({ root: mocks.root }) }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let host: HTMLDivElement, root: Root;
let actions: ReturnType<typeof useServiceActions>;
const request = { startRequest: vi.fn(), stopRequest: vi.fn(), refetch: vi.fn(), patchState: vi.fn(), onGeneration: vi.fn(), onClearConfirm: vi.fn() };
function Probe() { actions = useServiceActions({ ...request, name: "中间件", debugMode: false }); return <span>{actions.busy}</span>; }
beforeEach(async () => { vi.clearAllMocks(); mocks.root = "D:/project"; request.refetch.mockResolvedValue(null); host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(<Probe />)); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe("服务启动/取消并发", () => {
  it("同帧重复启动只发一个请求", async () => { const start = deferred<void>(); request.startRequest.mockReturnValue(start.promise); let first!: Promise<void>; await act(async () => { first = actions.start(); void actions.start(); }); expect(request.startRequest).toHaveBeenCalledTimes(1); await act(async () => { start.resolve(); await first; }); expect(actions.busy).toBeNull(); });
  it("准备期间停止可执行，晚到启动不能回写启动中", async () => { const start = deferred<void>(); request.startRequest.mockReturnValue(start.promise); request.stopRequest.mockResolvedValue("cancelling"); let first!: Promise<void>; await act(async () => { first = actions.start(); }); await act(async () => { await actions.stop(); }); expect(request.stopRequest).toHaveBeenCalledTimes(1); expect(actions.busy).toBe("stop"); await act(async () => { start.resolve(); await first; }); expect(request.patchState).not.toHaveBeenCalledWith("starting"); expect(actions.busy).toBeNull(); });
  it("停止操作同帧去重，成功后更新已停止", async () => { const stop = deferred<"stopped">(); request.stopRequest.mockReturnValue(stop.promise); let first!: Promise<void>; await act(async () => { first = actions.stop(); void actions.stop(); }); expect(request.stopRequest).toHaveBeenCalledTimes(1); await act(async () => { stop.resolve("stopped"); await first; }); expect(request.patchState).toHaveBeenCalledWith("stopped"); });
  it("重启发现准备未退出，不发第二次启动", async () => { request.stopRequest.mockResolvedValue("cancelling"); await act(async () => { await actions.restart(); }); expect(request.startRequest).not.toHaveBeenCalled(); });
  it("调试启动按显式参数，失败后可重试", async () => { request.startRequest.mockRejectedValueOnce(new Error("classpath失败")).mockResolvedValueOnce(undefined); await act(async () => { await actions.start(true); }); expect(request.startRequest).toHaveBeenLastCalledWith(true); expect(actions.busy).toBeNull(); await act(async () => { await actions.start(false); }); expect(request.startRequest).toHaveBeenLastCalledWith(false); expect(request.patchState).toHaveBeenCalledWith("starting"); });
  it("卸载后旧请求不更新状态和提示", async () => { const start = deferred<void>(); request.startRequest.mockReturnValue(start.promise); let first!: Promise<void>; await act(async () => { first = actions.start(); }); await act(async () => root.unmount()); await act(async () => { start.resolve(); await first; }); expect(request.patchState).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled(); root = createRoot(host); });
});
