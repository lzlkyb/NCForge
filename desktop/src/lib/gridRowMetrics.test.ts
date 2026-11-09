import { describe, expect, it } from "vitest";
import {
  MAX_WRAP_LINES, averageHeight, buildOffsets, offsetAt, rowAtOffset, rowHeights, wrapAvail, wrapLineCount,
} from "./gridRowMetrics";
import type { ColumnMeta } from "./dbApi";

const cols = (names: string[]): ColumnMeta[] => names.map(name => ({ name, type: "VARCHAR2" } as ColumnMeta));

describe("wrapLineCount", () => {
  it("短文本一行放得下", () => {
    expect(wrapLineCount("bd_material", 200)).toBe(1);
  });

  it("空串也算一行", () => {
    expect(wrapLineCount("", 100)).toBe(1);
  });

  it("显式换行符一定断行", () => {
    expect(wrapLineCount("a\nb\nc", 100)).toBe(3);
    // 快路径不认 `\n`：带换行符的短文本也必须逐段数
    expect(wrapLineCount("a\nb", 500)).toBe(2);
  });

  it("换行符加超宽文本时两者都算", () => {
    expect(wrapLineCount(`${"x".repeat(500)}\nend`, 100)).toBe(MAX_WRAP_LINES);
  });

  it("超宽文本折成多行", () => {
    const text = "x".repeat(500);
    const lines = wrapLineCount(text, 100);
    expect(lines).toBeGreaterThan(1);
    expect(lines).toBeLessThanOrEqual(MAX_WRAP_LINES);
  });

  it("中文按全角宽度折行", () => {
    // 40 个汉字在 200px 宽里：200/13.5 ≈ 14 字一行 → 3 行
    expect(wrapLineCount("材".repeat(40), 200)).toBe(3);
  });

  it("宽度不够时封顶，不会把一屏撑满", () => {
    expect(wrapLineCount("y".repeat(10000), 50)).toBe(MAX_WRAP_LINES);
  });
});

describe("rowHeights", () => {
  const columns = cols(["a", "b"]);
  const widths = [100, 100];

  it("关闭换行时全部等宽", () => {
    const rows = [["x".repeat(400), "短"], ["y", null]];
    expect(rowHeights(rows, columns, widths, false, 26)).toEqual([26, 26]);
  });

  it("开启换行后按本行最长的那一格算", () => {
    const rows = [["x".repeat(400), "短"], ["y", null]];
    const heights = rowHeights(rows, columns, widths, true, 26);
    expect(heights[0]).toBeGreaterThan(26);
    expect(heights[1]).toBe(26); // 两个格子都放得下
  });

  it("NULL 不参与测量", () => {
    expect(rowHeights([[null, null]], columns, widths, true, 26)).toEqual([26]);
  });

  it("行高是行高的整数倍", () => {
    const heights = rowHeights([["z".repeat(300)]], cols(["a"]), [80], true, 26);
    expect(heights[0] % 26).toBe(0);
  });
});

describe("buildOffsets / offsetAt / rowAtOffset", () => {
  const heights = [26, 52, 26, 78]; // 第 2、4 行换行变高
  const order = [0, 1, 2, 3];
  const { offsets, total } = buildOffsets(heights, order);

  it("前缀和与总高", () => {
    expect(offsets).toEqual([0, 26, 78, 104]);
    expect(total).toBe(182);
  });

  it("offsetAt 给出行距", () => {
    expect(offsetAt(offsets, 0)).toBe(0);
    expect(offsetAt(offsets, 3)).toBe(104);
  });

  it("筛选/排序后偏移跟着显示顺序走，不是行号", () => {
    const reversed = buildOffsets(heights, [3, 2, 1, 0]);
    expect(reversed.offsets).toEqual([0, 78, 104, 156]);
    expect(offsetAt(reversed.offsets, 1)).toBe(78);
  });

  it("rowAtOffset 二分落在上一行", () => {
    expect(rowAtOffset(offsets, 0)).toBe(0);
    expect(rowAtOffset(offsets, 25)).toBe(0);
    expect(rowAtOffset(offsets, 26)).toBe(1);
    expect(rowAtOffset(offsets, 77)).toBe(1);
    expect(rowAtOffset(offsets, 78)).toBe(2);
    expect(rowAtOffset(offsets, 1000)).toBe(3);
  });

  it("空表不炸", () => {
    const empty = buildOffsets([], []);
    expect(empty.total).toBe(0);
    expect(rowAtOffset(empty.offsets, 10)).toBe(0);
  });
});

describe("wrapAvail / averageHeight", () => {
  it("可用宽度扣掉 padding 与安全余量", () => {
    expect(wrapAvail(100)).toBe(76);
    expect(wrapAvail(10)).toBe(0);
  });

  it("平均行高在行高不固定时用于翻页", () => {
    expect(averageHeight(182, 4, 26)).toBe(45.5);
    expect(averageHeight(0, 0, 26)).toBe(26);
  });
});
