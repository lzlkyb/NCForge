import { describe, expect, it } from "vitest";
import { statsText, statsTitle } from "./dbStats";
import type { ExecStats } from "./dbApi";

/**
 * A2：Autotrace 统计行。
 *
 * 最关键的一条：读不到统计时返回 `null`（界面整行不渲染）。
 * 显示成「逻辑读 0」等于告诉用户「这条 SQL 一次读都没花」，比不显示更误导。
 */

const s = (over: Partial<ExecStats> = {}): ExecStats => ({
  dbBlockGets: 0,
  consistentGets: 0,
  logicalReads: 0,
  physicalReads: 0,
  executeCount: 1,
  ...over,
});

describe("statsText", () => {
  it("读不到统计时返回 null（不是 0 行）", () => {
    expect(statsText(null)).toBeNull();
    expect(statsText(undefined)).toBeNull();
  });

  it("数字带千分位", () => {
    expect(statsText(s({ logicalReads: 12345, physicalReads: 6 }))).toBe("逻辑读 12,345 · 物理读 6");
  });

  it("全 0 也照实显示（说明这条确实几乎没读盘）", () => {
    expect(statsText(s())).toBe("逻辑读 0 · 物理读 0");
  });
});

describe("statsTitle", () => {
  it("明细摊开当前读与一致读", () => {
    const t = statsTitle(s({ dbBlockGets: 3, consistentGets: 97, logicalReads: 100 }));
    expect(t).toContain("当前读 3");
    expect(t).toContain("一致读 97");
    expect(t).toContain("执行次数");
  });

  it("没有统计就没有悬停明细", () => {
    expect(statsTitle(null)).toBeNull();
  });
});
