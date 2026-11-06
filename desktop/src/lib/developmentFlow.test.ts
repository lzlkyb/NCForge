import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOPMENT_OPTIONS, executeDevelopmentFlow, isDevelopmentCancelled, type DevelopmentRuntime, type DevelopmentService, type DevelopmentTarget } from "./developmentFlow";
const ROOT = "C:\\work\\newar";
function runtime() {
  const calls: string[] = [], phases: string[] = [];
  const services: Record<DevelopmentTarget, DevelopmentService> = {
    middleware: { state: "stopped", projectRoot: ROOT, runId: null },
    client: { state: "stopped", projectRoot: ROOT, runId: null, serverReachable: true, host: "127.0.0.1", port: 8123 },
  };
  let root = ROOT, clock = 0, id = 0;
  const rt: DevelopmentRuntime = {
    root: ROOT, currentRoot: () => root,
    status: async (target) => ({ ...services[target] }),
    compile: async () => { calls.push("compile"); return true; }, cancelCompile: async () => { calls.push("cancelCompile"); },
    deploy: async () => { calls.push("deploy"); },
    start: async (target, debug, requestId) => { calls.push(`start:${target}:${debug}`); Object.assign(services[target], { state: "running", runId: requestId, debugPort: debug ? 5005 : null }); return requestId; },
    stop: async (target, expected) => { calls.push(`stop:${target}:${expected}`); if (services[target].runId === expected) services[target].state = "stopped"; },
    attach: async (target) => { calls.push(`attach:${target}`); },
    requestId: () => `owned-${++id}`, now: () => clock, waitMs: 2000,
    sleep: async (ms, signal) => { if (signal.aborted) throw Object.assign(new Error("cancel"), { name: "AbortError" }); clock += ms; },
  };
  const run = (options = DEFAULT_DEVELOPMENT_OPTIONS) => executeDevelopmentFlow(options, rt, (phase) => phases.push(phase));
  return { rt, calls, phases, services, run, switchRoot: () => { root = "C:\\work\\other"; } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
describe("开始开发的真实目标与顺序", () => {
  it("编译、投送、两个服务与显式调试附加按顺序执行", async () => {
    const f = runtime();
    const result = await f.run({ compile: true, deploy: true, client: true, debug: true, autoAttach: true }).done;
    expect(f.calls).toEqual(["compile", "deploy", "start:middleware:true", "start:client:true", "attach:middleware", "attach:client"]);
    expect(result).toEqual({ started: ["middleware", "client"], reused: [] });
  });
  it("HTTP已监听但客户端的真实目标不可达时不启动客户端", async () => {
    const f = runtime(); f.services.client.serverReachable = false;
    await expect(f.run().done).rejects.toThrow("127.0.0.1:8123");
    expect(f.calls).toEqual(["deploy", "start:middleware:false"]);
    expect(f.phases.some((phase) => phase.includes(":8123"))).toBe(true);
  });
  it("复用原有运行服务，不重启或重复开启调试", async () => {
    const f = runtime(); Object.assign(f.services.middleware, { state: "running", runId: "original-server" }); Object.assign(f.services.client, { state: "running", runId: "original-client" });
    const result = await f.run({ ...DEFAULT_DEVELOPMENT_OPTIONS, deploy: false, debug: true }).done;
    expect(result.reused).toEqual(["middleware", "client"]); expect(f.calls).toEqual([]);
    expect(f.services.middleware.runId).toBe("original-server");
  });
  it("预检端口冲突会阻止编译、投送与启动", async () => {
    const f = runtime(); f.services.middleware.portConflict = true;
    await expect(f.run({ ...DEFAULT_DEVELOPMENT_OPTIONS, compile: true }).done).rejects.toThrow("被其他进程占用"); expect(f.calls).toEqual([]);
  });
  it("另一工作区的运行服务不能被当前工程悄悄复用", async () => {
    const f = runtime(); Object.assign(f.services.middleware, { state: "running", projectRoot: "C:\\other" });
    await expect(f.run().done).rejects.toThrow("另一工作区"); expect(f.calls).toEqual([]);
  });
  it("已有独立启动操作时不覆盖它", async () => {
    const f = runtime(); Object.assign(f.services.middleware, { state: "starting", runId: "independent" });
    await expect(f.run().done).rejects.toThrow("已有启动操作"); expect(f.calls).toEqual([]);
  });
  it("编译失败和投送失败都不能继续启动", async () => {
    const compile = runtime(); compile.rt.compile = async () => false;
    await expect(compile.run({ ...DEFAULT_DEVELOPMENT_OPTIONS, compile: true }).done).rejects.toThrow("编译未通过"); expect(compile.calls).toEqual([]);
    const deploy = runtime(); deploy.rt.deploy = async () => { throw new Error("目标不可写"); };
    await expect(deploy.run().done).rejects.toThrow("目标不可写"); expect(deploy.calls).toEqual([]);
  });
  it("启动异常退出和运行身份替换都中断后续步骤", async () => {
    const failed = runtime(); failed.rt.start = async (target, _, id) => { Object.assign(failed.services[target], { state: "stopped", runId: id, exitCode: 1, reason: "主类未找到" }); return id; };
    await expect(failed.run().done).rejects.toThrow("主类未找到"); expect(failed.calls).toEqual(["deploy"]);
    const replaced = runtime(); replaced.rt.start = async (target, _, id) => { Object.assign(replaced.services[target], { state: "running", runId: "other-request" }); return id; };
    await expect(replaced.run().done).rejects.toThrow("被其他操作替换"); expect(replaced.calls).toEqual(["deploy"]);
  });
  it("当前服务没开JDWP时显式自动附加不会假装完成", async () => {
    const f = runtime(); f.services.middleware.state = "running";
    await expect(f.run({ ...DEFAULT_DEVELOPMENT_OPTIONS, debug: true, autoAttach: true }).done).rejects.toThrow("未开启调试"); expect(f.calls).toEqual([]);
  });
  it("等待客户端目标时中间件被独立重启，不接续旧流程", async () => {
    const f = runtime(); f.services.client.serverReachable = false;
    f.rt.sleep = async () => { f.services.middleware.runId = "independent-restart"; f.services.client.serverReachable = true; };
    await expect(f.run().done).rejects.toThrow("运行已被其他操作替换");
    expect(f.calls).toEqual(["deploy", "start:middleware:false"]);
  });
});
describe("开发流程取消与工作区隔离", () => {
  it("启动请求尚未返回runId时按预建ID取消，晚到成功不能继续启动客户端", async () => {
    const f = runtime(); let resolve!: (id: string) => void;
    f.rt.start = (target, _, id) => { Object.assign(f.services[target], { state: "starting", runId: id }); return new Promise<string>((done) => { resolve = done; }); };
    const execution = f.run(); await settle(); await execution.cancel();
    expect(f.calls).toEqual(["deploy", "stop:middleware:owned-1"]);
    resolve("owned-1"); await expect(execution.done).rejects.toMatchObject({ name: "AbortError" });
    expect(f.services.client.state).toBe("stopped");
  });
  it("取消身份不匹配时保留独立重启的新进程", async () => {
    const f = runtime(); let resolve!: (id: string) => void;
    f.rt.start = (target, _, id) => new Promise<string>((done) => { Object.assign(f.services[target], { state: "starting", runId: id }); resolve = done; });
    const execution = f.run(); await settle(); Object.assign(f.services.middleware, { state: "running", runId: "independent-new" }); await execution.cancel(); resolve("owned-1");
    await expect(execution.done).rejects.toMatchObject({ name: "AbortError" }); expect(f.services.middleware).toMatchObject({ state: "running", runId: "independent-new" });
  });
  it("取消目标等待保留原有运行服务", async () => {
    const f = runtime(); Object.assign(f.services.middleware, { state: "running", runId: "original" }); f.services.client.serverReachable = false;
    f.rt.sleep = async () => { await execution.cancel(); };
    const execution = f.run(); await expect(execution.done).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls).toEqual(["deploy"]); expect(f.services.middleware.state).toBe("running");
  });
  it("取消编译等待其收尾，不继续投送", async () => {
    const f = runtime(); let resolve!: (ok: boolean) => void;
    f.rt.compile = () => new Promise<boolean>((done) => { resolve = done; });
    const execution = f.run({ ...DEFAULT_DEVELOPMENT_OPTIONS, compile: true }); await settle(); await execution.cancel(); expect(f.calls).toEqual(["cancelCompile"]);
    resolve(true); await expect(execution.done).rejects.toMatchObject({ name: "AbortError" }); expect(f.services.middleware.state).toBe("stopped");
  });
  it("投送完成时已切工程，不启动旧工程服务", async () => {
    const f = runtime(); f.rt.deploy = async () => { f.switchRoot(); };
    await expect(f.run().done).rejects.toMatchObject({ name: "AbortError" }); expect(f.calls).toEqual([]);
  });
  it("请求取消失败不能报告已取消", async () => {
    const f = runtime(); let resolve!: (id: string) => void;
    f.rt.start = () => new Promise<string>((done) => { resolve = done; }); f.rt.stop = async () => { throw new Error("停止请求失败"); };
    const execution = f.run(); await settle(); await expect(execution.cancel()).rejects.toThrow("停止请求失败"); resolve("owned-1");
    await expect(execution.done).rejects.toThrow("停止请求失败");
    expect(isDevelopmentCancelled(new Error("停止请求失败"))).toBe(false);
  });
  it("取消请求失败可按同一运行身份重试", async () => {
    const f = runtime(); let resolve!: (id: string) => void, calls = 0;
    f.rt.start = () => new Promise<string>((done) => { resolve = done; });
    f.rt.stop = async (_, id) => { f.calls.push(id); if (++calls === 1) throw new Error("暂时无法停止"); };
    const execution = f.run(); await settle(); await expect(execution.cancel()).rejects.toThrow("暂时无法停止");
    await execution.cancel(); resolve("owned-1"); await expect(execution.done).rejects.toMatchObject({ name: "AbortError" }); expect(f.calls).toEqual(["deploy", "owned-1", "owned-1"]);
  });
});
