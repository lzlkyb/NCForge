import { describe, expect, it } from "vitest";
import { allResultSelection, gridSelectionCell, gridSelectionHeading, selectedEditableCells } from "./gridSelection";
it("全选依据筛选和排序后的行、显示列顺序，空数据不生成选区", () => {
  expect(allResultSelection([3, 0, 2], [4, 1])).toEqual({ anchor: { r: 3, c: 4 }, end: { r: 2, c: 1 } });
  expect(allResultSelection([], [0])).toBeNull(); expect(allResultSelection([0], [])).toBeNull();
});
describe("logical grid selection perimeter", () => {
  const bounds={rowStart:10,rowEnd:1000,colStart:2,colEnd:80};
  it("marks only true logical edges, including reversed/cross-screen ranges",()=>{
    expect(gridSelectionCell(bounds,10,2,false)["data-range-edges"]).toBe("top left");
    expect(gridSelectionCell(bounds,1000,80,false)["data-range-edges"]).toBe("bottom right");
    // First rendered row/column can be deep inside the range; it is not a perimeter.
    expect(gridSelectionCell(bounds,500,40,false)["data-range-edges"]).toBeUndefined();
    expect(gridSelectionCell(bounds,500,40,false)["data-cell"]).toBe(true);
    expect(gridSelectionCell(bounds,500,1,false)["data-cell"]).toBeUndefined();
  });
  it("retains one active cell and independent row/column heading state",()=>{
    expect(gridSelectionCell(bounds,1000,80,true)["data-active-cell"]).toBe(true);
    expect(gridSelectionCell(bounds,999,80,false)["data-active-cell"]).toBeUndefined();
    expect(gridSelectionHeading(bounds,40,"column")).toBe(true);
    expect(gridSelectionHeading(bounds,9,"row")).toBeUndefined();
    expect(gridSelectionHeading(null,10,"row")).toBeUndefined();
  });
  it("a single cell receives all four edges without losing active semantics",()=>{
    expect(gridSelectionCell({rowStart:0,rowEnd:0,colStart:0,colEnd:0},0,0,true)).toEqual({"data-cell":true,"aria-selected":true,"data-range-edges":"top bottom left right","data-active-cell":true});
  });
});

describe("选区里的可编辑格", () => {
  const order = [0, 1, 2];
  const visible = [0, 1];
  it("按原始行/列下标展开整个选区", () => {
    expect(selectedEditableCells({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }, order, visible, () => true))
      .toEqual([{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 0 }, { row: 1, col: 1 }]);
  });
  it("跳过不可编辑的列（主键、只读类型）", () => {
    expect(selectedEditableCells({ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 }, order, visible, c => c !== 1))
      .toEqual([{ row: 0, col: 0 }]);
  });
  it("没有选区时为空", () => {
    expect(selectedEditableCells(null, order, visible, () => true)).toEqual([]);
  });
});
