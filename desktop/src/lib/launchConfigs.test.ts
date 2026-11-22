import { describe, expect, it } from "vitest";
import {
  clientOverridesOf,
  emptyLaunchConfig,
  javaOptionsToRunConfig,
  launchConfigsOf,
  launchSummary,
  middlewareOverridesOf,
  runConfigToJavaOptions,
  type LaunchConfig,
  type LaunchConfigList,
  type LaunchTarget,
} from "./launchConfigs";

type JavaTarget = Extract<LaunchTarget, { kind: "java" }>;

const middleware = (over: Partial<Extract<LaunchConfig["target"], { kind: "middleware" }>> = {}): LaunchConfig =>
  ({ id: "lc-1", name: "中间件 8G", target: { kind: "middleware", heapMb: null, hotwebs: null, debug: false, ...over } });

const client = (over: Partial<Extract<LaunchConfig["target"], { kind: "client" }>> = {}): LaunchConfig =>
  ({ id: "lc-2", name: "客户端", target: { kind: "client", heapMb: null, debug: false, ...over } });

const java = (over: Partial<Extract<LaunchConfig["target"], { kind: "java" }>> = {}): LaunchConfig =>
  ({ id: "lc-3", name: "跑测试", target: { kind: "java", path: "src/A.java", mode: "main", classes: [], args: [], extraClasspath: [], debug: false, coverage: false, ...over } });

describe("启动配置摘要", () => {
  it("中间件：堆与 web 应用都跟随全局时如实说明", () => {
    expect(launchSummary(middleware())).toBe("堆随全局 · web 应用随全局");
  });
  it("中间件：显式堆按 GB 取整，带调试时标注", () => {
    expect(launchSummary(middleware({ heapMb: 8192, hotwebs: ["ncchr", "iwebap"], debug: true }))).toBe("8G · 2 个 web 应用 · 调试");
  });
  it("客户端：堆取整，调试开关写明", () => {
    expect(launchSummary(client({ heapMb: 768, debug: true }))).toBe("1G · 调试");
    expect(launchSummary(client({ heapMb: 512 }))).toBe("1G · 无调试");
  });
  it("Java：方式、目标数与调试/覆盖率", () => {
    expect(launchSummary(java({ mode: "test", classes: ["a.B#t", "a.C"], debug: true, coverage: true }))).toBe("JUnit · 2 个目标 · 调试 · 覆盖率");
  });
});

describe("启动配置派生", () => {
  it("按目标类型过滤，空列表安全", () => {
    const list: LaunchConfigList = { configs: [middleware(), client(), java()], notes: [], savedId: null };
    expect(launchConfigsOf(list, "middleware").map((c) => c.id)).toEqual(["lc-1"]);
    expect(launchConfigsOf(list, "java").map((c) => c.id)).toEqual(["lc-3"]);
    expect(launchConfigsOf(undefined, "client")).toEqual([]);
  });
  it("空模板按类型给对应形状，id 留空由后端分配", () => {
    expect(emptyLaunchConfig("middleware", "新配置")).toEqual({ id: "", name: "新配置", target: { kind: "middleware", heapMb: null, hotwebs: null, debug: false } });
    expect(emptyLaunchConfig("java", "新配置").target).toMatchObject({ kind: "java", path: "", mode: "main", classes: [] });
  });
});

describe("选中配置转启动覆盖值", () => {
  it("未选中或类型不符 = 不覆盖", () => {
    expect(middlewareOverridesOf(null)).toBeUndefined();
    expect(middlewareOverridesOf(client())).toBeUndefined();
    expect(clientOverridesOf(middleware())).toBeUndefined();
  });
  it("中间件覆盖同时带堆与 web 应用名单", () => {
    expect(middlewareOverridesOf(middleware({ heapMb: 4096, hotwebs: ["ncchr"] }))).toEqual({ heapMb: 4096, hotwebs: ["ncchr"] });
  });
  it("客户端只带堆", () => {
    expect(clientOverridesOf(client({ heapMb: 1024 }))).toEqual({ heapMb: 1024 });
  });
});

describe("Java 配置与运行面板互转", () => {
  const target: JavaTarget = { kind: "java", path: "src/A.java", mode: "test", classes: ["a.B#t"], args: ["-x"], extraClasspath: ["lib/a.jar"], debug: false, coverage: false };
  it("结构态转文本态：数组合并成换行分隔", () => {
    expect(javaOptionsToRunConfig(target)).toEqual({ path: "src/A.java", mode: "test", classes: "a.B#t", args: "-x", extraClasspath: "lib/a.jar" });
  });
  it("文本态转结构态可 round-trip，调试/覆盖率由调用方给", () => {
    const config = javaOptionsToRunConfig(target);
    expect(runConfigToJavaOptions(config, true, true)).toEqual({ ...target, debug: true, coverage: true });
  });
  it("每行一项、去空白、丢空行", () => {
    const options = runConfigToJavaOptions(
      { path: " src/A.java ", mode: "test", classes: " a.B#t \n\n a.C", args: "-x\n", extraClasspath: "  \n lib/a.jar " },
      false,
      false,
    );
    expect(options).toEqual({ ...target, path: "src/A.java", classes: ["a.B#t", "a.C"], extraClasspath: ["lib/a.jar"] });
  });
});
