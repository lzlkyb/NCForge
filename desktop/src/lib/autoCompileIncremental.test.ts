import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  incremental: vi.fn(),
  enabled: true,
  state: {} as Record<string, unknown>,
}));

vi.mock("./compile", () => ({
  compileIncremental: mocks.incremental,
  isCompileCancelled: (e: unknown) => String(e instanceof Error ? e.message : e).includes("CANCELLED"),
}));
vi.mock("./appConfig", () => ({ isAutoIncrementalEnabled: async () => mocks.enabled }));
vi.mock("./workspaceSession", () => ({
  getSession: () => mocks.state,
  setSession: (patch: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(patch)) {
      mocks.state[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(mocks.state[k]) : v;
    }
  },
}));

import { scheduleIncremental, resetIncremental, incrementalPending, INCREMENTAL_IDLE_MS } from "./autoCompileIncremental";

const RESULT = {
  ok: true, durationMs: 1, sourceCount: 1, errorCount: 0, warningCount: 0,
  problems: [], jarCount: 0, rounds: 1, outDir: "classes", diagnostics: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  resetIncremental();
  mocks.incremental.mockReset();
  mocks.incremental.mockResolvedValue(RESULT);
  mocks.enabled = true;
  mocks.state = { root: "D:/p", compiling: false, compileResult: null };
});
afterEach(() => {
  resetIncremental();
  vi.useRealTimers();
});

describe("模块级增量第二阶段", () => {
  it("静默期内的重复保存合并成一次，只编一次", async () => {
    scheduleIncremental(["D:/p/A.java"]);
    await vi.advanceTimersByTimeAsync(INCREMENTAL_IDLE_MS - 1);
    scheduleIncremental(["D:/p/A.java", "D:/p/B.java"]);
    await vi.runAllTimersAsync();
    expect(mocks.incremental).toHaveBeenCalledTimes(1);
    expect(mocks.incremental).toHaveBeenCalledWith(["D:/p/A.java", "D:/p/B.java"]);
    expect(mocks.state.compiling).toBe(false);
    expect(mocks.state.compileResult).not.toBeNull();
    expect(incrementalPending()).toBe(false);
  });

  it("手动编译占着闸时推迟重试，不抢编译闸", async () => {
    mocks.state.compiling = true;
    scheduleIncremental(["D:/p/A.java"]);
    await vi.advanceTimersByTimeAsync(INCREMENTAL_IDLE_MS);
    expect(mocks.incremental).not.toHaveBeenCalled();
    expect(incrementalPending()).toBe(true);

    mocks.state.compiling = false;
    await vi.advanceTimersByTimeAsync(7_000);
    expect(mocks.incremental).toHaveBeenCalledWith(["D:/p/A.java"]);
  });

  it("开关关掉时清空排队，不起编译", async () => {
    mocks.enabled = false;
    scheduleIncremental(["D:/p/A.java"]);
    await vi.runAllTimersAsync();
    expect(mocks.incremental).not.toHaveBeenCalled();
    expect(incrementalPending()).toBe(false);
  });

  it("没有工作区时丢弃排队", async () => {
    mocks.state.root = null;
    scheduleIncremental(["D:/p/A.java"]);
    await vi.runAllTimersAsync();
    expect(mocks.incremental).not.toHaveBeenCalled();
    expect(incrementalPending()).toBe(false);
  });
});
