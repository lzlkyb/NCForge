// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: h.invoke }));

import {
  dedupeKey, describeError, installGlobalErrorLogging,
  recordFrontendError, resetFrontendLogForTest, shouldRecord,
} from "./frontendLog";

beforeEach(() => {
  h.invoke.mockReset();
  h.invoke.mockResolvedValue(undefined);
  resetFrontendLogForTest();
});

describe("describeError：Tauri 拒绝的是字符串不是 Error", () => {
  it("字符串原样保留，不带 Error 前缀", () => {
    // 🔴 后端 invoke 拒绝字符串。若这里给它包一层 Error，日志里会多出
    // "Error: " 前缀，与操作中心的分类判据（startsWith("CONFLICT")）不一致。
    expect(describeError("CONFLICT: 磁盘已改")).toEqual({ message: "CONFLICT: 磁盘已改" });
  });

  it("Error 取 message 与 stack", () => {
    const e = new Error("渲染失败");
    const got = describeError(e);
    expect(got.message).toBe("渲染失败");
    expect(got.stack).toContain("渲染失败");
  });

  it("类 Error 对象与循环引用都不抛", () => {
    expect(describeError({ message: "来自对象", stack: "at X" })).toEqual({ message: "来自对象", stack: "at X" });
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => describeError(cyclic)).not.toThrow();
    expect(describeError(undefined).message).toBe("undefined");
  });
});

describe("去重与节流：崩溃路径不能刷爆磁盘", () => {
  it("同一条 5 秒内只记一次，超过窗口再记", () => {
    // 🔴 必须钉死时钟：原来写 `Date.now() + 4999`，而记录时刻与断言时刻之间
    // 只要过了 ≥1ms，`now - last` 就到 5000 ⇒ 判 true。单跑时快看不出来，
    // 与 ErrorBoundary 测试同跑（前置变慢）就稳定红（2026-11-16 实测）。
    // 边界断言一律用固定基准，别拿真实时钟做加减。
    const t0 = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      recordFrontendError("render", "同一个错");
      recordFrontendError("render", "同一个错");
      expect(h.invoke).toHaveBeenCalledTimes(1);
      const key = dedupeKey("render", "同一个错");
      expect(shouldRecord(key, t0 + 4999, 1)).toBe(false);
      expect(shouldRecord(key, t0 + 5000, 1)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("不同故障点不互相压制", () => {
    recordFrontendError("render", { message: "A", stack: "at A.tsx:1" });
    recordFrontendError("render", { message: "A", stack: "at B.tsx:2" });
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("单次会话上限后不再写", () => {
    expect(shouldRecord("k", Date.now(), 200)).toBe(false);
    expect(shouldRecord("k", Date.now(), 199)).toBe(true);
  });

  it("🔴 invoke 失败绝不抛错，且必须自己吞掉拒绝", async () => {
    // 🔴 只断言 not.toThrow() 抓不住「去掉 .catch()」：那产生的是 unhandled
    // rejection，同步断言看不见（2026-11-16 红灯实测 exit=0）。
    // 也别靠 window 的 unhandledrejection —— **jsdom 不派发这个事件**（实测监听器收不到），
    // vitest 虽会单列 Unhandled Errors 但判定时序不稳。
    // 正解：直接钉住「调用方对 invoke 返回的 promise 挂了 catch」这个行为本身。
    const rejected = Promise.reject("后端没这个命令"); // Tauri 拒绝的是字符串不是 Error
    const catchSpy = vi.spyOn(rejected, "catch");
    h.invoke.mockReturnValue(rejected);
    expect(() => recordFrontendError("render", "崩了")).not.toThrow();
    expect(catchSpy).toHaveBeenCalledTimes(1);
    // 自己消费掉，避免给本次 run 留真的未处理拒绝
    await rejected.catch(() => undefined);
  });

  it("🔴 连参数组装都失败也不抛", () => {
    const evil = { get message() { throw new Error("取值就炸"); } };
    expect(() => recordFrontendError("render", evil)).not.toThrow();
  });

  it("带上 kind 与 page，便于定位哪个工作面崩的", () => {
    recordFrontendError("render", "x", "db");
    expect(h.invoke).toHaveBeenCalledWith("frontend_log_append",
      expect.objectContaining({ kind: "render", message: "x", page: "db" }));
  });
});

describe("全局兜底：ErrorBoundary 抓不到的异常", () => {
  it("window error 与 unhandledrejection 都落盘，卸载后不再记", () => {
    const off = installGlobalErrorLogging(() => "editor");
    window.dispatchEvent(new ErrorEvent("error", { message: "事件回调炸了" }));
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: "异步炸了" });
    window.dispatchEvent(rejection);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(h.invoke).toHaveBeenNthCalledWith(1, "frontend_log_append",
      expect.objectContaining({ kind: "window.onerror", page: "editor" }));
    expect(h.invoke).toHaveBeenNthCalledWith(2, "frontend_log_append",
      expect.objectContaining({ kind: "unhandledrejection", message: "异步炸了" }));
    off();
    window.dispatchEvent(new ErrorEvent("error", { message: "卸载后不该记" }));
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("重复安装不叠加监听", () => {
    // 🔴 不能只数 invoke 次数：去重会把第二次调用压掉，监听器翻倍也看不出来
    // （2026-11-16 红灯实测：去掉「只装一次」守卫仍 11 passed）。
    // 这里直接数监听器本身 —— 用 spy 记录 addEventListener 的实际调用。
    const add = vi.spyOn(window, "addEventListener");
    const off1 = installGlobalErrorLogging();
    const firstRound = add.mock.calls.filter(c => c[0] === "error" || c[0] === "unhandledrejection").length;
    installGlobalErrorLogging();
    const secondRound = add.mock.calls.filter(c => c[0] === "error" || c[0] === "unhandledrejection").length;
    expect(firstRound).toBe(2);
    expect(secondRound).toBe(firstRound);
    add.mockRestore();
    // 行为侧再确认一次：仍然只落一条
    window.dispatchEvent(new ErrorEvent("error", { message: "只记一次" }));
    expect(h.invoke).toHaveBeenCalledTimes(1);
    off1();
  });
});