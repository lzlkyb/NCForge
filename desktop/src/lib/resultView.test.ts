import { describe, expect, it } from "vitest";
import { initialWidths, nextSort, viewOrder } from "./resultView";

const cols = [
  { name: "CODE", type: "VARCHAR2(40)", precision: 40, scale: 0 },
  { name: "QTY", type: "NUMBER(28,8)", precision: 28, scale: 8 },
];
const rows = [
  ["b", "10"],
  ["a", "9"],
  ["c", null],
];

describe("viewOrder", () => {
  it("数字列按数值排，NULL 永远在最后", () => {
    expect(viewOrder(rows, cols, "", { col: 1, dir: "asc" })).toEqual([1, 0, 2]);
    expect(viewOrder(rows, cols, "", { col: 1, dir: "desc" })).toEqual([0, 1, 2]);
  });

  it("文本列与筛选", () => {
    expect(viewOrder(rows, cols, "", { col: 0, dir: "asc" })).toEqual([1, 0, 2]);
    expect(viewOrder(rows, cols, "C", null)).toEqual([2]);
    expect(viewOrder(rows, cols, "9", null)).toEqual([1]);
  });

  it("表头三态切换", () => {
    expect(nextSort(null, 1)).toEqual({ col: 1, dir: "asc" });
    expect(nextSort({ col: 1, dir: "asc" }, 1)).toEqual({ col: 1, dir: "desc" });
    expect(nextSort({ col: 1, dir: "desc" }, 1)).toBeNull();
  });

  it("列宽有上下限", () => {
    const w = initialWidths(cols, [["x".repeat(500), "1"]]);
    expect(w[0]).toBe(320);
    expect(w[1]).toBeGreaterThanOrEqual(64);
  });
});
