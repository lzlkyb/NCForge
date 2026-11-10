// @vitest-environment jsdom
/**
 * 执行历史的落盘策略：内存里立刻可见，写盘 300ms 合并，清空立即写。
 *
 * 这三点缺一个都会在真实使用里出问题：等落盘才显示 → 历史抽屉慢半拍；
 * 每条都写 → 回放脚本时主线程反复序列化 500 条 SQL；清空也防抖 → 刚清掉的历史又回来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "ncforge-db-history";
const at = (n: number) => ({ at: n, sql: `insert into t values (${n})`, ms: 1, summary: "更新 1 行", ok: true });

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const writes = (set: { mock: { calls: unknown[][] } }) => set.mock.calls.filter(c => c[0] === KEY).length;

describe("执行历史写盘", () => {
  it("300ms 内连续执行只序列化一次，列表仍然立刻可读", async () => {
    const h = await import("./dbHistory");
    const set = vi.spyOn(Storage.prototype, "setItem");
    for (let i = 0; i < 40; i++) h.addHistory("c1", at(i));
    expect(h.getHistoryMap().c1).toHaveLength(40);
    expect(writes(set)).toBe(0);
    vi.advanceTimersByTime(300);
    expect(writes(set)).toBe(1);
    expect(JSON.parse(localStorage.getItem(KEY)!).c1).toHaveLength(40);
  });

  it("清空立即落盘，不等合并窗口", async () => {
    const h = await import("./dbHistory");
    h.addHistory("c1", at(1));
    h.addHistory("c2", at(2));
    h.flushHistory();
    const set = vi.spyOn(Storage.prototype, "setItem");
    h.clearHistory("c2");
    expect(writes(set)).toBe(1);
    expect(JSON.parse(localStorage.getItem(KEY)!).c1).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(KEY)!).c2).toBeUndefined();
  });

  it("手动 flush 后，合并窗口到点不重复写", async () => {
    const h = await import("./dbHistory");
    h.addHistory("c1", at(1));
    h.flushHistory();
    const set = vi.spyOn(Storage.prototype, "setItem");
    vi.advanceTimersByTime(1000);
    expect(writes(set)).toBe(0);
  });
});
