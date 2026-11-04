import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  openVirtualModel: vi.fn(),
  // moduleOfPath 从会话读 root，测试要能改
  root: "C:\\ws" as string | null,
}));

vi.mock("./monacoSetup", () => ({ monaco: { editor: {}, languages: {}, MarkerSeverity: {} } }));
vi.mock("./editorStore", () => ({
  forEachModel: vi.fn(),
  onModelLifecycle: vi.fn(),
  openVirtualModel: (...a: unknown[]) => h.openVirtualModel(...a),
}));
vi.mock("./tauri", () => ({ invoke: (...a: unknown[]) => h.invoke(...a), listen: vi.fn() }));
vi.mock("./appConfig", () => ({ getConfig: () => ({}) }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: h.root }) }));

import { ensureLang, loadJdtSource, restartLang, startLangNow, stopLang } from "./lang";

const JAVA = "C:\\ws\\gl\\A.java";

describe("loadJdtSource", () => {
  beforeEach(() => {
    h.invoke.mockReset();
    h.openVirtualModel.mockReset();
  });

  it("同一地址只请求一次，但每次都重建只读 model（标签关掉后再跳转不能空白）", async () => {
    h.invoke.mockResolvedValue("class A {}");
    const uri = "jdt://contents/a.jar/p/A.class";
    await loadJdtSource(uri);
    await loadJdtSource(uri);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.openVirtualModel).toHaveBeenCalledTimes(2);
    expect(h.openVirtualModel).toHaveBeenLastCalledWith(uri, "class A {}", { replace: true });
  });

  it("请求失败不缓存，下次可重试", async () => {
    const uri = "jdt://contents/b.jar/p/B.class";
    h.invoke.mockRejectedValueOnce(new Error("boom"));
    await expect(loadJdtSource(uri)).rejects.toThrow();
    h.invoke.mockResolvedValueOnce("class B {}");
    await loadJdtSource(uri);
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("签名桩会换成本地反编译结果，并在正文里标出处", async () => {
    const uri = "jdt://contents/pubgl.jar/nc/bs/gl/GlBO.class";
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "decompile_class") {
        return {
          source: "package nc.bs.gl;\n\npublic class GlBO {}\n",
          jar: "D:\\ncc\\1909home\\modules\\gl\\lib\\pubgl.jar",
          class: "nc.bs.gl.GlBO",
          ms: 250,
        };
      }
      return "// Failed to get sources. Instead, stub sources have been generated\npublic class GlBO {}";
    });
    const src = await loadJdtSource(uri);
    expect(src.decompiled).toBe(true);
    expect(src.decompileError).toBeUndefined();
    expect(src.text).toContain("反编译自 pubgl.jar");
    expect(src.text).toContain("public class GlBO {}");
    expect(h.openVirtualModel).toHaveBeenLastCalledWith(uri, src.text, { replace: true });
  });

  it("反编译失败降级成桩并带回原因（不抛错，jar 里的类照样能打开）", async () => {
    const uri = "jdt://contents/nope.jar/p/N.class";
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "decompile_class") throw "在 NC 安装目录与工作区里都没找到 nope.jar";
      return "// Failed to get sources. Instead, stub sources have been generated\npublic class N {}";
    });
    const src = await loadJdtSource(uri);
    expect(src.decompiled).toBe(false);
    expect(src.text).toContain("Failed to get sources");
    expect(src.decompileError).toContain("nope.jar");
  });

  it("有真源码时不去反编译", async () => {
    const uri = "jdt://contents/withsrc.jar/p/S.class";
    h.invoke.mockResolvedValue("package p;\n\npublic class S {}\n");
    const src = await loadJdtSource(uri);
    expect(src.decompiled).toBe(false);
    expect(h.invoke.mock.calls.every((c) => c[0] !== "decompile_class")).toBe(true);
  });

  it("预览不反编译（一次跳转可能预建多个候选，起多个 JVM 不值得）", async () => {
    const uri = "jdt://contents/prev.jar/p/P.class";
    const stub = "// Failed to get sources. Instead, stub sources have been generated\npublic class P {}";
    h.invoke.mockResolvedValue(stub);
    const src = await loadJdtSource(uri, true);
    expect(src.decompiled).toBe(false);
    expect(h.invoke.mock.calls.every((c) => c[0] !== "decompile_class")).toBe(true);
    expect(h.openVirtualModel).toHaveBeenLastCalledWith(uri, stub, { peek: true });
    // 正式打开同一条地址时才反编译，并把 model 内容换掉
    h.invoke.mockImplementation(async (cmd: string) =>
      cmd === "decompile_class"
        ? { source: "public class P {}", jar: "prev.jar", class: "p.P", ms: 1 }
        : stub,
    );
    const full = await loadJdtSource(uri);
    expect(full.decompiled).toBe(true);
    expect(h.openVirtualModel).toHaveBeenLastCalledWith(uri, full.text, { replace: true });
  });
});

describe("lang_start / lang_stop 串行与意图代际", () => {
  beforeEach(() => {
    h.root = "C:\\ws";
    h.invoke.mockReset();
    h.invoke.mockImplementation(async (cmd: string) => (cmd === "lang_stop" ? undefined : {}));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("防抖到点正常拉起（回归：串行化不改变happy path）", async () => {
    ensureLang(JAVA);
    await vi.advanceTimersByTimeAsync(1499);
    expect(h.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.invoke).toHaveBeenCalledWith("lang_start", { path: JAVA });
  });

  it("stop 在途时，后发的 start 排队等它做完，不会两条 IPC 并发", async () => {
    let release = () => {};
    h.invoke.mockImplementation(
      (cmd: string) =>
        cmd === "lang_stop"
          ? new Promise<void>((res) => {
              release = () => res();
            })
          : Promise.resolve({}),
    );

    const stopping = stopLang();
    void startLangNow(JAVA);
    await Promise.resolve();
    // 这一刻 stop 还没回来：start 必须还在队列里等，不能已经发出去
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("lang_stop");

    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledWith("lang_start", { path: JAVA });
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("防抖窗口里停过服务：旧意图作废，不给旧工作区的路径拉起 jdt.ls", async () => {
    ensureLang(JAVA);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.invoke).not.toHaveBeenCalled();

    // 防抖还剩 500ms 时切了工作区：stop 取消防抖并自增代际
    const stopping = stopLang();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.invoke).not.toHaveBeenCalledWith("lang_start", expect.anything());

    await stopping;
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("lang_stop");
  });

  it("启动排在在途 stop 后面、执行前又停过一次：放弃执行，不发 lang_start", async () => {
    const releases: Array<() => void> = [];
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "lang_stop"
        ? new Promise<void>((res) => releases.push(() => res()))
        : Promise.resolve({}),
    );

    // 第 1 次切走：stop 在途（后端杀 jdt.ls 要一两秒才回来）
    stopLang();
    // 新工作区打开 .java：防抖调度（代际记的是第 1 次 stop 之后）
    ensureLang(JAVA);
    await vi.advanceTimersByTimeAsync(1500);
    // 防抖点到了，但 start  job 排在在途 stop 后面，还没轮到执行
    expect(h.invoke).not.toHaveBeenCalledWith("lang_start", expect.anything());

    // 又切了一次工作区：第 2 次 stop 插到队尾
    stopLang();
    // 第 1 次 stop 回来，排队的 start 轮到执行：核代际发现停过第二次 → 放弃
    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).not.toHaveBeenCalledWith("lang_start", expect.anything());

    // 收尾：把第 2 次 stop 也放行，别把未决的 promise 留给后面的用例
    releases[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(h.invoke).not.toHaveBeenCalledWith("lang_start", expect.anything());
  });

  it("stop 之后的新意图有效：切完工作区打开 .java 照样能起服务", async () => {
    const stopping = stopLang();
    // 切换完成、用户在新工作区打开文件：这是 stop 之后登记的意图
    ensureLang(JAVA);
    await stopping;
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.invoke).toHaveBeenCalledWith("lang_start", { path: JAVA });
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("stop 失败不毒死队列：随后的手动启动照样执行", async () => {
    h.invoke.mockImplementationOnce(() => Promise.reject(new Error("stop boom")));
    h.invoke.mockImplementation(async (cmd: string) => (cmd === "lang_stop" ? undefined : {}));

    // 重启时 stop 失败：和改之前一样抛给调用方，且不再发 start
    await expect(restartLang(JAVA)).rejects.toThrow("stop boom");
    expect(h.invoke).not.toHaveBeenCalledWith("lang_start", expect.anything());

    void startLangNow(JAVA);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledWith("lang_start", { path: JAVA });
  });
});
import { clearCompletedOperations, getOperations } from "./operations";

describe("手动语言服务请求反馈", () => {
  beforeEach(async () => {
    h.root = "C:\\ws"; h.invoke.mockReset();
    h.invoke.mockImplementation(async cmd => cmd === "lang_stop" ? undefined : { state: "indexing", module: "gl", message: "indexing", sourceFiles: 10, jarCount: 1 });
    vi.useFakeTimers(); await stopLang(); h.invoke.mockClear(); clearCompletedOperations();
  });
  afterEach(async () => { await vi.advanceTimersByTimeAsync(0); clearCompletedOperations(); vi.useRealTimers(); });
  it("启动请求返回 indexing 后准确说明索引仍由状态栏报告", async () => {
    startLangNow(JAVA); await vi.advanceTimersByTimeAsync(0);
    const operations = getOperations(), operation = operations[operations.length - 1];
    expect(operation.state).toBe("success"); expect(operation.label).toBe("请求启动代码智能");
    expect(operation.detail).toContain("索引是否就绪以状态栏为准");
  });
  it("启动按钮同帧连点只发送一次请求", async () => {
    let done!: () => void;
    h.invoke.mockImplementation(() => new Promise<void>(resolve => { done = resolve; }));
    startLangNow(JAVA); startLangNow(JAVA); await Promise.resolve(); await Promise.resolve();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    done(); await vi.advanceTimersByTimeAsync(0);
  });
  it("启动失败结束任务，允许用户重新点击", async () => {
    h.invoke.mockRejectedValueOnce(new Error("failed handshake"));
    startLangNow(JAVA); await vi.advanceTimersByTimeAsync(0);
    const operations = getOperations(); expect(operations[operations.length - 1].state).toBe("failed");
    startLangNow(JAVA); await vi.advanceTimersByTimeAsync(0); expect(h.invoke).toHaveBeenCalledTimes(2);
  });
  it("自动 ensureLang 不登记全局用户任务", async () => {
    ensureLang(JAVA); await vi.advanceTimersByTimeAsync(1500);
    expect(getOperations()).toHaveLength(0);
  });
});
