import { describe, expect, it, vi } from "vitest";
import { chainAt, flattenSymbols, kindLetter } from "./symbols";

// symbols 依赖 lang（间接拉起 Monaco，jsdom / node 里都起不来），本测试只测纯函数部分
vi.mock("./lang", () => ({ flushDoc: vi.fn(), langRequest: vi.fn() }));

const r = (a: number, b: number) => ({ start: { line: a, character: 2 }, end: { line: b, character: 0 } });

describe("flattenSymbols", () => {
  it("层级形态：展开 children，记外层名与深度，行列转成 1 基", () => {
    const out = flattenSymbols([
      {
        name: "VoucherBO",
        kind: 5,
        range: r(0, 20),
        selectionRange: { start: { line: 1, character: 13 }, end: { line: 1, character: 22 } },
        children: [{ name: "save", kind: 6, range: r(4, 15), selectionRange: { start: { line: 4, character: 21 }, end: { line: 4, character: 25 } } }],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: "VoucherBO", line: 2, column: 14, startLine: 1, endLine: 21, depth: 0, container: "" });
    expect(out[1]).toMatchObject({ name: "save", line: 5, column: 22, container: "VoucherBO", depth: 1 });
  });

  it("平铺形态：用 location.range 与 containerName", () => {
    const out = flattenSymbols([{ name: "save", kind: 6, containerName: "VoucherBO", location: { range: r(4, 15) } }]);
    expect(out[0]).toMatchObject({ name: "save", container: "VoucherBO", line: 5, startLine: 5, endLine: 16 });
  });

  it("不是数组 / 缺字段就跳过，不扔错", () => {
    expect(flattenSymbols(null)).toEqual([]);
    expect(flattenSymbols([{ kind: 5 }, { name: "x" }])).toEqual([]);
  });
});

describe("chainAt", () => {
  const syms = flattenSymbols([
    { name: "A", kind: 5, range: r(0, 30), selectionRange: r(0, 0), children: [
      { name: "f", kind: 6, range: r(2, 10), selectionRange: r(2, 2) },
      { name: "g", kind: 6, range: r(12, 20), selectionRange: r(12, 12) },
    ] },
  ]);

  it("光标在方法里：类 → 方法", () => {
    expect(chainAt(syms, 6).map((s) => s.name)).toEqual(["A", "f"]);
  });
  it("光标在类里、方法外：只有类", () => {
    expect(chainAt(syms, 12).map((s) => s.name)).toEqual(["A"]);
  });
  it("光标在任何符号外：空链", () => {
    expect(chainAt(syms, 40)).toEqual([]);
  });
});

describe("kindLetter", () => {
  it("常见种类", () => {
    expect([5, 11, 10, 6, 9, 8, 14, 99].map(kindLetter)).toEqual(["C", "I", "E", "M", "M", "F", "F", "·"]);
  });
});
