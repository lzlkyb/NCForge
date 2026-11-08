import { describe, expect, it } from "vitest";
import {
  CELL_CHROME,
  HEADER_CHROME,
  fitWidth,
  fitsCell,
  initialWidths,
  nextSort,
  rowNumberWidth,
  textWidth,
  viewOrder,
} from "./resultView";

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
});

describe("textWidth", () => {
  it("空串是 0，且随内容单调不变窄", () => {
    expect(textWidth("")).toBe(0);
    expect(textWidth("ABCDEF")).toBeGreaterThan(textWidth("ABC"));
  });

  it("中文比同字数的拉丁宽", () => {
    expect(textWidth("物料名称")).toBeGreaterThan(textWidth("ABCD"));
  });
});

describe("initialWidths", () => {
  // 🔴 表头文本之外还有 52px 固定开销（padding 20 + 列菜单 18 + 排序箭头 14），
  // 少留这一截就会让每个列名都以 `…` 结尾——这是这次要守的回归点。
  const headerNeed = (name: string) => textWidth(name.toLowerCase(), true) + HEADER_CHROME;

  it("列名能完整显示", () => {
    const long = [{ name: "OUTTRANSLATEJSON", type: "CLOB", precision: 0, scale: 0 }];
    const w = initialWidths(long, [[null]])[0];
    expect(w).toBeGreaterThanOrEqual(headerNeed("OUTTRANSLATEJSON"));
    // 旧公式（字符数 × 7.4 + 28）算出 146，比表头实际需要的少 24px 以上
    expect(w).toBeGreaterThan(146);
  });

  it("短列名也不吃到下限以下", () => {
    const short = [{ name: "PK_HEAD", type: "VARCHAR2(20)", precision: 20, scale: 0 }];
    const w = initialWidths(short, [["1001A1"]])[0];
    expect(w).toBeGreaterThanOrEqual(headerNeed("PK_HEAD"));
    // 旧公式给 7 个字符的列名算出 80，扣掉 52px 固定开销只剩 28px ⇒ 显示成 `pk_…`
    expect(w).toBeGreaterThan(80);
  });

  it("值的宽度也算进去，但超长值封顶", () => {
    const one = [{ name: "J", type: "CLOB", precision: 0, scale: 0 }];
    const short = initialWidths(one, [["x".repeat(20)]])[0];
    const huge = initialWidths(one, [["x".repeat(500)]])[0];
    expect(huge).toBeGreaterThan(short);
    expect(huge).toBe(420);
  });

  it("空结果只按列名给宽，不会塌到 0", () => {
    const w = initialWidths(cols, []);
    expect(w.every((x) => x >= 72)).toBe(true);
  });

  it("中文值比同字数的拉丁值宽", () => {
    const one = [{ name: "NAME", type: "VARCHAR2", precision: 100, scale: 0 }];
    const chinese = initialWidths(one, [["物料名称甲乙"]])[0];
    const latin = initialWidths(one, [["ABCDEF"]])[0];
    expect(chinese).toBeGreaterThan(latin);
  });

  it("采样会往后看，不只前 50 行", () => {
    const one = [{ name: "CODE", type: "VARCHAR2(40)", precision: 40, scale: 0 }];
    const late = Array.from({ length: 80 }, (_, i) => [i === 70 ? "x".repeat(40) : "a"]);
    expect(initialWidths(one, late)[0]).toBeGreaterThan(initialWidths(one, [["a"]])[0]);
  });

  it("单列 fit 与全量计算一致（右键「本列自适应」用它）", () => {
    const one = [{ name: "CODE", type: "VARCHAR2(40)", precision: 40, scale: 0 }];
    expect(fitWidth(one[0], [["abcdefgh"]], 0)).toBe(initialWidths(one, [["abcdefgh"]])[0]);
  });
});

describe("fitsCell", () => {
  it("宽度够就 true，扣掉 padding 后不够就 false", () => {
    const text = "abcdef";
    const need = textWidth(text) + CELL_CHROME;
    expect(fitsCell(text, need)).toBe(true);
    expect(fitsCell(text, need - 2)).toBe(false);
  });

  it("超长文本不测量也判 false（走长度下界）", () => {
    expect(fitsCell("x".repeat(3000), 420)).toBe(false);
  });

  it("宽度小于 padding 时直接 false", () => {
    expect(fitsCell("a", 10)).toBe(false);
  });
});

describe("rowNumberWidth", () => {
  // `.dbx-gc` 是 border-box，左右各 10px padding；13px tabular-nums 每位约 7.8px。
  const CONTENT = (w: number) => w - 20;
  const NEED = (n: number) => String(n).length * 7.8;

  it("三位数起不再被 ellipsis 吃掉", () => {
    for (const n of [9, 99, 100, 999, 1000, 9999, 10_000]) {
      expect(CONTENT(rowNumberWidth(n))).toBeGreaterThanOrEqual(NEED(n));
    }
  });

  it("随位数单调变宽，且不比原下限窄", () => {
    expect(rowNumberWidth(99)).toBeLessThan(rowNumberWidth(100));
    expect(rowNumberWidth(999)).toBeLessThan(rowNumberWidth(1000));
    expect(rowNumberWidth(0)).toBeGreaterThanOrEqual(40);
  });
});
