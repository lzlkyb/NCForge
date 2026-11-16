import { beforeEach, describe, expect, it } from "vitest";
import { clear, percentile, record, snapshot, summarize } from "./interactionBudget";

beforeEach(() => clear());

describe("交互延迟采样", () => {
  it("空样本不报错，百分位为 0", () => {
    expect(percentile([], 95)).toBe(0);
    expect(summarize([])).toEqual({});
    expect(snapshot().samples).toHaveLength(0);
  });

  it("最近秩百分位：p95 取第 95% 个样本，不插值", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
  });

  it("按 kind 分组汇总，取整输出", () => {
    [10, 20, 30, 40, 50].forEach((ms) => record("keydown", ms));
    record("command", 120);
    const s = summarize(snapshot().samples);
    expect(s.keydown).toEqual({ n: 5, p50: 30, p95: 50, max: 50 });
    expect(s.command).toEqual({ n: 1, p50: 120, p95: 120, max: 120 });
  });

  it("丢弃非法样本（NaN / 负数），不让它们污染百分位", () => {
    record("keydown", Number.NaN);
    record("keydown", -5);
    record("keydown", 42);
    expect(snapshot().samples).toHaveLength(1);
    expect(snapshot().summary.keydown.p95).toBe(42);
  });

  it("超过 500 条只保留最近的样本", () => {
    for (let i = 0; i < 520; i += 1) record("keydown", i);
    const { samples } = snapshot();
    expect(samples).toHaveLength(500);
    expect(samples[samples.length - 1].ms).toBe(519);
  });
});
