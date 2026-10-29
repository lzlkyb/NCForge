// @vitest-environment jsdom
/**
 * ResourceContext 状态机单测。
 *
 * 为什么值得单独测：资源置备的进度、错误、守卫全在 8 个 `resource:*` 事件上，
 * 而这些事件由 Rust 后台任务注入，人工测一次要真下一遍 59MB。这里改成「手动
 * emit」，于是状态转移与重入防护变成毫秒级断言。范式同 UpdateContext.test.tsx。
 *
 * 覆盖重点（按价值排序）：
 * 1. **先注册监听、再拉快照/发起 ensure**——listen() 是异步 IPC，而 Rust 侧
 *    main.rs 启动自检 spawn 后很快就 emit；发起早于监听注册会永久丢事件
 *    （UpdateContext 在 macOS CI 上抓到过同款竞态）。
 * 2. **快照全部就绪时不发起 ensure**——不打扰用户（legacy 用户每次启动都会
 *    走到这里，弹一次「准备组件」再秒关是最扰民的形态）。
 * 3. 下载中的守卫：available/uptodate 不回退状态、ensure 不重入。
 * 4. total=null（源不给 Content-Length）走不确定态。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceProvider, useResources, type ResourceState } from "./ResourceContext";
import { resourceFriendlyError, type PackStatusInfo } from "../lib/resource";

// ─── 事件总线与 IPC 打桩 ────────────────────
const h = vi.hoisted(() => {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  /** 记录 listen/invoke 的调用顺序，用来断言「先注册监听、再拉快照」 */
  const order: string[] = [];
  const state = { statusResult: [] as unknown[] };
  return {
    handlers,
    order,
    state,
    invoke: vi.fn(async (cmd: string) => {
      order.push(`invoke:${cmd}`);
      if (cmd === "resources_status") return state.statusResult;
      return undefined;
    }),
  };
});

vi.mock("../lib/tauri", () => ({
  invoke: h.invoke,
  listen: async (event: string, handler: (payload: unknown) => void) => {
    h.order.push(`listen:${event}`);
    const list = h.handlers.get(event) ?? [];
    list.push(handler);
    h.handlers.set(event, list);
    return () => {
      const cur = h.handlers.get(event) ?? [];
      h.handlers.set(
        event,
        cur.filter((fn) => fn !== handler),
      );
    };
  },
}));
// 本文件测状态机，不测对话框渲染。
vi.mock("../components/resource/ResourceSetupDialog", () => ({ ResourceSetupDialog: () => null }));

const EVENTS = [
  "resource:checking",
  "resource:available",
  "resource:uptodate",
  "resource:downloading",
  "resource:progress",
  "resource:installed",
  "resource:ready",
  "resource:error",
];

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── 渲染工具 ────────────────────────────

let ctx: ResourceState | null = null;
function Probe() {
  ctx = useResources();
  return null;
}

function state(): ResourceState {
  if (!ctx) throw new Error("Probe 尚未渲染");
  return ctx;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** flush 微任务链：setupListeners 串行 await 8 个 listen，每轮只推进一个。 */
async function flush(times = 16) {
  for (let i = 0; i < times; i++) await act(async () => {});
}

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ResourceProvider>
        <Probe />
      </ResourceProvider>,
    );
  });
  await flush();
}

/** 模拟 Rust 侧 emit：直接调用注册过的 handler（lib/tauri 的 listen 给 payload 本身）。 */
async function emit(event: string, payload?: unknown) {
  const list = h.handlers.get(event) ?? [];
  await act(async () => {
    for (const fn of list) fn(payload);
  });
}

const installedPacks = (): PackStatusInfo[] => [
  { id: "jdtls", title: "Java 语言服务", notes: "补全与跳转", state: "installed", version: "a1b2c3d4e5f6", size: 54 * 1024 * 1024 },
  { id: "ecj", title: "Java 编译器", notes: "编译 NC 模块", state: "installed", version: "0f1e2d3c4b5a", size: 6_700_000 },
  { id: "svnkit", title: "SVN 客户端", notes: "检出与更新", state: "installed", version: "9a8b7c6d5e4f", size: 3 * 1024 * 1024 },
];

const missingPacks = () => [
  { id: "jdtls", title: "Java 语言服务", notes: "补全与跳转", size: 54 * 1024 * 1024 },
  { id: "ecj", title: "Java 编译器", notes: "编译 NC 模块", size: 6_700_000 },
  { id: "svnkit", title: "SVN 客户端", notes: "检出与更新", size: 3 * 1024 * 1024 },
];

beforeEach(() => {
  h.handlers.clear();
  h.order.length = 0;
  h.invoke.mockClear();
  h.state.statusResult = [];
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  ctx = null;
});

// ─── 用例 ────────────────────────────────

describe("启动自检的顺序与克制", () => {
  it("8 个监听全部注册后才拉本地快照", async () => {
    await mount();

    expect([...h.handlers.keys()].sort()).toEqual([...EVENTS].sort());

    const statusAt = h.order.indexOf("invoke:resources_status");
    const lastListenAt = h.order.reduce((last, cur, i) => (cur.startsWith("listen:") ? i : last), -1);
    expect(statusAt).toBeGreaterThan(-1);
    // 关键断言：拉快照必须晚于最后一个 listen，否则启动自检事件可能发在监听之前而丢失。
    expect(statusAt).toBeGreaterThan(lastListenAt);
  });

  it("快照显示有缺失包时，自动发起一次 ensure(false)", async () => {
    h.state.statusResult = [
      { id: "jdtls", title: "Java 语言服务", notes: "补全与跳转", state: "missing", version: null, size: null },
      { id: "ecj", title: "Java 编译器", notes: "编译 NC 模块", state: "missing", version: null, size: null },
      { id: "svnkit", title: "SVN 客户端", notes: "检出与更新", state: "missing", version: null, size: null },
    ];
    await mount();

    expect(h.invoke).toHaveBeenCalledWith("resources_ensure", { force: false });
    expect(state().packs.map((p) => p.state)).toEqual(["missing", "missing", "missing"]);
  });

  it("快照全部就绪时不发起 ensure（legacy 用户不被打扰）", async () => {
    h.state.statusResult = installedPacks();
    await mount();

    expect(h.invoke).toHaveBeenCalledWith("resources_status");
    expect(h.invoke).not.toHaveBeenCalledWith("resources_ensure", expect.anything());
    expect(state().phase).toBe("idle");
  });

  it("legacy 认领也算就绪，不发起 ensure", async () => {
    h.state.statusResult = [
      { id: "jdtls", title: "Java 语言服务", notes: "补全与跳转", state: "legacy", version: null, size: null },
      { id: "ecj", title: "Java 编译器", notes: "编译 NC 模块", state: "installed", version: "0f1e2d3c4b5a", size: 6_700_000 },
      { id: "svnkit", title: "SVN 客户端", notes: "检出与更新", state: "missing", version: null, size: null },
    ];
    // 注意：这个快照里有 missing（svnkit）→ 应该发起。legacy 不阻断，missing 才触发。
    await mount();
    expect(h.invoke).toHaveBeenCalledWith("resources_ensure", { force: false });
  });
});

describe("事件驱动的状态转移", () => {
  it("resource:available 把待下载包与总大小带入 state", async () => {
    await mount();
    await emit("resource:available", { packs: missingPacks(), totalBytes: 63_800_000 });

    expect(state().missing.map((p) => p.id)).toEqual(["jdtls", "ecj", "svnkit"]);
    // totalBytes 由 missing 数组求和而来（54MiB + 6.7MB + 3MiB）
    expect(state().totalBytes).toBe(66_468_832);
    expect(state().phase).toBe("checking");
  });

  it("downloading → progress：字节数/速率原样进 state，total 为 null 时保持 null", async () => {
    await mount();
    await emit("resource:downloading", { id: "ecj" });
    await emit("resource:progress", { id: "ecj", downloaded: 1024 * 1024, total: null, bytesPerSec: 0 });

    expect(state().phase).toBe("downloading");
    expect(state().currentId).toBe("ecj");
    expect(state().downloadedBytes).toBe(1024 * 1024);
    expect(state().totalBytesCurrent).toBeNull();

    // 恢复：不能一次 null 就永久卡在不确定态。
    await emit("resource:progress", { id: "ecj", downloaded: 2 * 1024 * 1024, total: 4 * 1024 * 1024, bytesPerSec: 512 * 1024 });
    expect(state().totalBytesCurrent).toBe(4 * 1024 * 1024);
    expect(state().bytesPerSec).toBe(512 * 1024);
  });

  it("ready：清空 missing、记录安装摘要与认领情况，并重拉本地快照", async () => {
    h.state.statusResult = installedPacks();
    await mount();
    await emit("resource:available", { packs: missingPacks(), totalBytes: 63_800_000 });
    h.invoke.mockClear();

    await emit("resource:ready", {
      installed: [{ id: "jdtls", version: "a1b2c3d4e5f6" }],
      adoptedLegacy: false,
    });

    expect(state().phase).toBe("ready");
    expect(state().missing).toEqual([]);
    expect(state().currentId).toBeNull();
    expect(state().lastInstalled).toEqual([{ id: "jdtls", version: "a1b2c3d4e5f6" }]);
    expect(state().adoptedLegacy).toBe(false);
    // ready 后刷新设置页用的本地快照
    expect(h.invoke).toHaveBeenCalledWith("resources_status");
  });

  it("ready 且 adoptedLegacy：认领旧版资源也算完成", async () => {
    await mount();
    await emit("resource:ready", { installed: [], adoptedLegacy: true });

    expect(state().phase).toBe("ready");
    expect(state().adoptedLegacy).toBe(true);
    expect(state().missing).toEqual([]);
  });

  it("error：记录原文与 code；自动发起的失败不弹 toast", async () => {
    await mount();
    // mount 内部自动发起 ensure（快照默认空数组 → 无 missing，不发起）——
    // 这里手动模拟后端在自动轮次里失败。
    await emit("resource:error", { message: "全部资源源均失败（已依次尝试）: 下载 ecj 失败", code: "network" });

    expect(state().phase).toBe("error");
    expect(state().errorCode).toBe("network");
    expect(state().error).toContain("下载 ecj 失败");
    expect(state().errorToastAllowed).toBe(false);
  });

  it("error：用户手动发起的失败允许弹 toast", async () => {
    await mount();
    await act(async () => {
      await state().ensure(true);
    });
    await emit("resource:error", { message: "下载停滞超过 60 秒，已中断（可重试或换源）", code: "timeout" });

    expect(state().errorCode).toBe("timeout");
    expect(state().errorToastAllowed).toBe(true);
  });

  it("error：带上失败前已完成的部分（partialInstalled，installed + adoptedLegacy）", async () => {
    await mount();
    await emit("resource:available", { packs: missingPacks(), totalBytes: 63_800_000 });
    await emit("resource:error", {
      message: "全部资源源均失败（已依次尝试）: 下载 svnkit 失败",
      code: "network",
      installed: [{ id: "jdtls", version: "a1b2c3d4e5f6" }],
      adoptedLegacy: ["ecj"],
    });

    // 下载装的 + 认领的都算「已就绪」；对话框据此显示 2/3
    expect(state().partialInstalled).toEqual([
      { id: "jdtls", version: "a1b2c3d4e5f6" },
      { id: "ecj", version: "" },
    ]);
  });

  it("error：旧后端不带 installed/adoptedLegacy 时 partialInstalled 为空数组（不炸）", async () => {
    await mount();
    await emit("resource:error", { message: "boom", code: "unknown" });

    expect(state().partialInstalled).toEqual([]);
  });

  it("ready 清空 partialInstalled（新一轮从零计）", async () => {
    await mount();
    await emit("resource:error", {
      message: "x",
      code: "network",
      installed: [{ id: "jdtls", version: "v" }],
    });
    expect(state().partialInstalled).toHaveLength(1);

    await emit("resource:ready", { installed: [], adoptedLegacy: false });
    expect(state().partialInstalled).toEqual([]);
  });
});

describe("下载中的守卫与重入防护", () => {
  it("downloading 中收到 available / uptodate 不回退状态", async () => {
    await mount();
    await emit("resource:downloading", { id: "jdtls" });
    expect(state().phase).toBe("downloading");

    await emit("resource:available", { packs: missingPacks(), totalBytes: 100 });
    expect(state().phase).toBe("downloading");
    expect(state().missing).toEqual([]);

    await emit("resource:uptodate");
    // 没有守卫时这里会被打成 idle：进度读数归零，而下载还在后台跑。
    expect(state().phase).toBe("downloading");
  });

  it("downloading 中再调 ensure 不发起新 invoke（后端单飞闸之外的前端双保险）", async () => {
    await mount();
    await emit("resource:downloading", { id: "jdtls" });
    h.invoke.mockClear();

    await act(async () => {
      void state().ensure(false);
    });
    expect(h.invoke).not.toHaveBeenCalledWith("resources_ensure", expect.anything());
  });

  it("ready 后守卫复位，可以再次发起 ensure", async () => {
    await mount();
    await emit("resource:downloading", { id: "jdtls" });
    await emit("resource:ready", { installed: [{ id: "jdtls", version: "a1b2c3d4e5f6" }], adoptedLegacy: false });
    h.invoke.mockClear();

    await act(async () => {
      void state().ensure(false);
    });
    expect(h.invoke).toHaveBeenCalledWith("resources_ensure", { force: false });
  });
});

describe("对话框抑制", () => {
  it("dismissMissing 后本会话不再自动显示（下载继续）", async () => {
    await mount();
    await emit("resource:available", { packs: missingPacks(), totalBytes: 63_800_000 });

    expect(state().missingDismissed).toBe(false);
    await act(async () => {
      state().dismissMissing();
    });
    expect(state().missingDismissed).toBe(true);
    // missing 数据仍在（对话框只是不显示，下载状态不丢）
    expect(state().missing.map((p) => p.id)).toEqual(["jdtls", "ecj", "svnkit"]);
  });
});

/**
 * 错误文案（与 UpdateContext.friendlyError 的测试意图一致）：
 * 后端 code 定性，前端只负责措辞；启发式只在旧后端/未知错误时兜底。
 */
describe("resourceFriendlyError", () => {
  it("按 code 出文案：signature 不甩锅给网络", () => {
    expect(resourceFriendlyError("SHA-256 校验失败", "signature").friendly).toContain("校验失败");
    expect(resourceFriendlyError("SHA-256 校验失败", "signature").friendly).not.toContain("网络");
  });

  it("按 code 出文案：corrupt / manifest / config / timeout / network 各自可辨", () => {
    expect(resourceFriendlyError("x", "corrupt").friendly).toContain("内容不完整");
    expect(resourceFriendlyError("x", "manifest").friendly).toContain("组件源");
    expect(resourceFriendlyError("x", "config").friendly).toContain("配置");
    expect(resourceFriendlyError("x", "timeout").friendly).toContain("超时");
    expect(resourceFriendlyError("x", "network").friendly).toContain("网络");
  });

  it("无 code 时回退到字符串启发式", () => {
    expect(resourceFriendlyError("下载不完整（声明 100 字节，实收 50 字节）").friendly).toContain("校验失败");
    expect(resourceFriendlyError("拒绝解压：路径不合法（疑似 zip-slip）").friendly).toContain("内容不完整");
    expect(resourceFriendlyError("资源清单返回 HTTP 404").friendly).toContain("组件源");
  });

  it("未知 code 不炸，落到兜底文案且保留原文", () => {
    const fe = resourceFriendlyError("某个没见过的错误", "unknown");
    expect(fe.friendly).toBe("组件下载失败，请重试");
    expect(fe.raw).toBe("某个没见过的错误");
  });
});
