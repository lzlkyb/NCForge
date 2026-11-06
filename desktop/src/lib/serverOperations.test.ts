import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn(), hidden: false }));
vi.mock("./tauri", () => ({ invoke: mock.invoke }));
vi.mock("./appVisibility", () => ({ isAppHidden: () => mock.hidden }));
import { serverStart, serverStop } from "./server";
import { cancelOperation, clearCompletedOperations, getOperations } from "./operations";
const task = () => getOperations().find(o => o.key === "service.start")!;
beforeEach(() => { vi.useFakeTimers(); mock.invoke.mockReset(); mock.hidden = false; clearCompletedOperations(); });
afterEach(() => { vi.useRealTimers(); });
describe("服务启动任务真实状态", () => {
  it("启动请求返回后保持运行，只有监听就绪才结束；同一期间不能重复启动", async () => {
    let running = false;
    mock.invoke.mockImplementation(async (cmd, args) => cmd === "server_status" ? { state: running ? "running" : "starting", port: 80 } : cmd === "server_start" ? args.requestId : undefined);
    await serverStart();
    expect(task().state).toBe("running");
    await expect(serverStart()).rejects.toThrow("服务正在启动");
    expect(mock.invoke.mock.calls.filter(c => c[0] === "server_start")).toHaveLength(1);
    running = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(task()).toMatchObject({ state: "success", detail: "本进程已监听端口 80" });
  });
  it("停止请求不能立刻当作取消完成，后端状态停止后才结束", async () => {
    let stopped = false;
    mock.invoke.mockImplementation(async (cmd, args) => cmd === "server_status" ? { state: stopped ? "stopped" : "starting", port: 80, reason: null } : cmd === "server_start" ? args.requestId : "cancelling");
    await serverStart();
    await cancelOperation(task().id);
    expect(task().state).toBe("cancelling");
    stopped = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(task().state).toBe("cancelled");
  });
  it("服务按钮停止正在启动的服务也以取消结束，不报启动失败", async () => {
    let stopped = false;
    mock.invoke.mockImplementation(async (cmd, args) => cmd === "server_status" ? { state: stopped ? "stopped" : "starting", port: 80 } : cmd === "server_start" ? args.requestId : "stopped");
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
  it("准备期间取消精确传本次身份，不误停随后独立运行", async () => {
    let resolve!:(id:string)=>void;
    let runId = "first-run";
    mock.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "server_start") return new Promise<string>(yes => { resolve = yes; });
      if (cmd === "server_status") return {state:"starting",runId,port:80,reason:null};
      if (cmd === "server_stop") return "cancelling";
      return args?.requestId;
    });
    const starting = serverStart(false, {requestId:runId,skipDeploy:true});
    await cancelOperation(task().id);
    expect(mock.invoke).toHaveBeenCalledWith("server_stop", {expectedRunId:"first-run"});
    resolve(runId); await starting; runId = "second-run";
    await vi.advanceTimersByTimeAsync(1000);
    expect(task().state).toBe("cancelled");
    expect(mock.invoke.mock.calls.filter(c=>c[0]==="server_stop").every(c=>c[1].expectedRunId==="first-run")).toBe(true);
  });
  it("迟到的旧状态响应不能完成另一次启动", async () => {
    mock.invoke.mockImplementation(async (cmd,args) => cmd === "server_start" ? args.requestId : {state:"running",runId:"unrelated-run",port:80,reason:null});
    await serverStart(false,{requestId:"requested-run"}); await Promise.resolve();
    expect(task()).toMatchObject({state:"cancelled",detail:"本次运行已被替换"});
  });
  it("准备期间同步本次真实阶段，忽略上次已停止状态", async () => {
    let resolve!: (id: string) => void;
    let status = { state: "stopped", runId: "old-run", port: 80, launchPhase: null as string | null };
    mock.invoke.mockImplementation(async cmd => cmd === "server_start" ? new Promise<string>(yes => { resolve = yes; }) : status);
    const starting = serverStart(false, { requestId: "preparing-run" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(task()).toMatchObject({ state: "running", phase: "检查环境" });
    status = { state: "starting", runId: "preparing-run", port: 80, launchPhase: "准备 classpath" };
    await vi.advanceTimersByTimeAsync(1000);
    expect(task()).toMatchObject({ state: "running", phase: "准备 classpath" });
    status = { ...status, state: "running" }; resolve("preparing-run"); await starting;
    await Promise.resolve(); expect(task().state).toBe("success");
  });
  it("隐藏窗口暂停准备和就绪状态IPC，恢复可见后完成", async () => {
    mock.hidden = true;
    let resolve!: (id: string) => void;
    mock.invoke.mockImplementation(async cmd => cmd === "server_start" ? new Promise<string>(yes => { resolve = yes; }) : { state: "running", runId: "hidden-run", port: 80 });
    const starting = serverStart(false, { requestId: "hidden-run" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(mock.invoke.mock.calls.filter(c => c[0] === "server_status")).toHaveLength(0);
    resolve("hidden-run"); await starting; await vi.advanceTimersByTimeAsync(2000);
    expect(mock.invoke.mock.calls.filter(c => c[0] === "server_status")).toHaveLength(0);
    mock.hidden = false; await vi.advanceTimersByTimeAsync(1000);
    expect(task().state).toBe("success");
  });
  it("停止请求失败后恢复观察，不永久卡在取消中", async () => {
    let running = false;
    mock.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "server_start") return args.requestId;
      if (cmd === "server_stop") throw new Error("cannot stop process");
      return { state: running ? "running" : "starting", runId: "cancel-error", port: 80 };
    });
    await serverStart(false, { requestId: "cancel-error" });
    await cancelOperation(task().id);
    expect(task()).toMatchObject({ state: "running", detail: "停止请求失败：Error: cannot stop process" });
    running = true; await vi.advanceTimersByTimeAsync(1000);
    expect(task().state).toBe("success");
  });
});
