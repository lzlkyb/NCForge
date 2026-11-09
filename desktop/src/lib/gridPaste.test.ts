import { describe, expect, it } from "vitest";
import { parseClipboardGrid, pasteTargets } from "./gridPaste";

describe("parseClipboardGrid", () => {
  it("按制表符分列、换行分行", () => {
    expect(parseClipboardGrid("a\tb\nc\td")).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("Windows 换行与尾部换行不产生多余空行", () => {
    expect(parseClipboardGrid("a\tb\r\nc\td\r\n")).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("引号包住的字段里制表符与换行都是值的一部分", () => {
    expect(parseClipboardGrid('"a\tb"\tc\n"x\ny"\tz')).toEqual([["a\tb", "c"], ["x\ny", "z"]]);
  });
  it("两个双引号表示一个字面引号", () => {
    expect(parseClipboardGrid('"say ""hi"""\t1')).toEqual([['say "hi"', "1"]]);
  });
  it("空字段是 NULL，不是空串", () => {
    expect(parseClipboardGrid("a\t\tc")).toEqual([["a", null, "c"]]);
  });
  it("单个值只有一格", () => {
    expect(parseClipboardGrid("42")).toEqual([["42"]]);
  });
  it("空剪贴板没有格子", () => {
    expect(parseClipboardGrid("")).toEqual([]);
  });
});

describe("pasteTargets", () => {
  const order = [0, 1, 2];
  const visible = [0, 1];
  const all = () => true;

  it("单个值铺满整个选区", () => {
    const cells = pasteTargets([["x"]], { r: 0, c: 0 }, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }, order, visible, all);
    expect(cells).toEqual([
      { row: 0, col: 0, value: "x" },
      { row: 0, col: 1, value: "x" },
      { row: 1, col: 0, value: "x" },
      { row: 1, col: 1, value: "x" },
    ]);
  });

  it("多格从活动格按块铺开，超出范围的部分丢弃", () => {
    const cells = pasteTargets([["a", "b"], ["c", "d"]], { r: 1, c: 0 }, null, order, visible, all);
    expect(cells).toEqual([
      { row: 1, col: 0, value: "a" },
      { row: 1, col: 1, value: "b" },
      { row: 2, col: 0, value: "c" },
      { row: 2, col: 1, value: "d" },
    ]);
  });

  it("不可编辑的格子跳过，不打断整块", () => {
    const cells = pasteTargets([["a", "b"]], { r: 0, c: 0 }, null, order, visible, (c) => c !== 1);
    expect(cells).toEqual([{ row: 0, col: 0, value: "a" }]);
  });
});
