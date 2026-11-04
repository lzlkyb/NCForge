import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_COMPILE_DEBOUNCE_MS,
  AUTO_COMPILE_MAX_RETRIES,
  AUTO_COMPILE_RETRY_MS,
  queueAutoCompile,
  requeueAutoCompile,
  resetAutoCompileQueue,
  setAutoCompileRunner,
} from "./autoCompileQueue";

describe("autoCompileQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAutoCompileQueue();
  });

  afterEach(() => {
    setAutoCompileRunner(null);
    resetAutoCompileQueue();
    vi.useRealTimers();
  });

  it("防抖窗口内的多次保存合并成一批，同一个文件只编一次", async () => {
    const calls: string[][] = [];
    setAutoCompileRunner(async (paths) => {
      calls.push(paths);
    });
    queueAutoCompile("a.java");
    queueAutoCompile("b.java");
    queueAutoCompile("a.java");
    // 窗口没到之前一次都不该跑：每次保存都起一个 JVM 太浪费
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_DEBOUNCE_MS);
    expect(calls).toEqual([["a.java", "b.java"]]);
  });

  it("没有执行者时入队直接丢弃：不该攒下永远不会跑的路径", async () => {
    const calls: string[][] = [];
    setAutoCompileRunner(null);
    queueAutoCompile("a.java");
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_DEBOUNCE_MS);
    setAutoCompileRunner(async (paths) => {
      calls.push(paths);
    });
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_DEBOUNCE_MS);
    expect(calls).toHaveLength(0);
  });

  it("上一批没跑完时新来的攒着，等它结束再跑（不并发撞后端的编译闸）", async () => {
    const calls: string[][] = [];
    let release: () => void = () => {};
    const first = new Promise<void>((r) => {
      release = r;
    });
    setAutoCompileRunner(async (paths) => {
      calls.push(paths);
      if (calls.length === 1) await first;
    });

    queueAutoCompile("a.java");
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);

    queueAutoCompile("b.java");
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_DEBOUNCE_MS);
    // 第一批还挂着，第二批只能等着
    expect(calls).toHaveLength(1);

    release();
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_DEBOUNCE_MS);
    expect(calls).toEqual([["a.java"], ["b.java"]]);
  });

  it("一批抛错不会卡死队列", async () => {
    const calls: string[][] = [];
    setAutoCompileRunner(async (paths) => {
      calls.push(paths);
      if (calls.length === 1) throw new Error("boom");
    });
    queueAutoCompile("a.java");
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_DEBOUNCE_MS);
    queueAutoCompile("b.java");
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
  });

  it("注销执行者时清掉待跑队列", async () => {
    const calls: string[][] = [];
    setAutoCompileRunner(async (paths) => {
      calls.push(paths);
    });
    queueAutoCompile("a.java");
    setAutoCompileRunner(null);
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_DEBOUNCE_MS);
    expect(calls).toHaveLength(0);
  });

  it("入队返回值告诉调用方「这次会不会编」", () => {
    setAutoCompileRunner(null);
    expect(queueAutoCompile("a.java")).toBe(false);
    setAutoCompileRunner(async () => {});
    expect(queueAutoCompile("a.java")).toBe(true);
  });

  it("被编译闸挡回来时按重试间隔重排，不丢这次保存", async () => {
    const calls: string[][] = [];
    setAutoCompileRunner(async (paths) => {
      calls.push(paths);
    });
    queueAutoCompile("a.java");
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);

    requeueAutoCompile(["a.java"]);
    // 重试间隔比普通防抖长：手动编译要跑几十秒，1.5 秒后再试才不至于空转
    await vi.advanceTimersByTimeAsync(AUTO_COMPILE_RETRY_MS - 100);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([["a.java"], ["a.java"]]);
  });

  it("重试用尽后放弃，不会无限重排", async () => {
    const calls: string[][] = [];
    setAutoCompileRunner(async (paths) => {
      calls.push(paths);
    });
    for (let i = 0; i <= AUTO_COMPILE_MAX_RETRIES + 2; i += 1) {
      requeueAutoCompile(["a.java"]);
      await vi.advanceTimersByTimeAsync(AUTO_COMPILE_RETRY_MS);
    }
    // 40 次上限 + 第 1 次（上限判断在入队前）——精确值不重要，关键是它是有限的
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(AUTO_COMPILE_MAX_RETRIES + 2);
  });
});
