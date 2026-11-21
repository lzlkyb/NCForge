import { describe, expect, it } from "vitest";
import { describeFastIndex, fmtBytes, fmtCount, type FastIndexStatus } from "./fastIndex";

function st(patch: Partial<FastIndexStatus>): FastIndexStatus {
  return {
    state: "ready",
    types: 298_357,
    sourceFiles: 7_419,
    jarTypes: 290_567,
    builtAtMs: Date.parse("2026-11-21T15:30:00"),
    indexBytes: 21_055_304,
    buildMs: 21_400,
    failures: 0,
    error: null,
    ...patch,
  };
}

describe("声明索引状态文案", () => {
  it("就绪时给出规模、体积与建立时间", () => {
    const text = describeFastIndex(st({}));
    expect(text).toContain("29.8 万");
    expect(text).toContain("jar 29.1 万");
    expect(text).toContain("20.1 MB");
    expect(text).toContain("建于");
  });

  it("构建中不显示规模（那时还没有数）", () => {
    const text = describeFastIndex(st({ state: "building", types: 0, jarTypes: 0, indexBytes: 0 }));
    expect(text).toContain("正在建立");
    expect(text).not.toContain("万");
  });

  it("失败时带上原因与重试次数；首次失败不写次数", () => {
    expect(describeFastIndex(st({ state: "failed", error: "索引器退出码 1", failures: 1 }))).toContain(
      "索引器退出码 1",
    );
    expect(describeFastIndex(st({ state: "failed", failures: 1 }))).not.toContain("连续失败");
    expect(describeFastIndex(st({ state: "failed", failures: 3 }))).toContain("连续失败 3 次");
  });

  it("未建立时说明会自动开始，避免用户以为坏了", () => {
    expect(describeFastIndex(st({ state: "none" }))).toContain("自动开始");
  });

  it("量级与体积格式化", () => {
    expect(fmtCount(9_999)).toBe("9999");
    expect(fmtCount(7_419)).toBe("7419");
    expect(fmtCount(10_000)).toBe("1 万");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2_048)).toBe("2 KB");
    expect(fmtBytes(20 * 1024 * 1024)).toBe("20.0 MB");
  });
});
