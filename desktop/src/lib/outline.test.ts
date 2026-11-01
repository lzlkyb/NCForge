import { describe, expect, it } from "vitest";
import { buildOutline, filterOutline, moveActive, outlineRows } from "./outline";
import type { FlatSymbol } from "./symbols";

const sym = (name: string, line: number, depth = 0, container = ""): FlatSymbol => ({
  name,
  kind: 6,
  container,
  line,
  column: 1,
  startLine: line,
  endLine: line + 10,
  depth,
});

describe("buildOutline", () => {
  it("层级形态按 depth 嵌", () => {
    const tree = buildOutline([sym("VoucherBO", 1), sym("save", 10, 1), sym("check", 20, 1), sym("validate", 22, 2)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((n) => n.sym.name)).toEqual(["save", "check"]);
    expect(tree[0].children[1].children[0].sym.name).toBe("validate");
  });

  it("平铺形态（depth 全 0）按 containerName 的段数补深度", () => {
    // jdt.ls 回 SymbolInformation 时 depth 全是 0，嵌套只体现在 containerName 上。
    // 不做这层补偿，整棵树会摊成一层——方法看起来和类同级。
    const tree = buildOutline([
      sym("VoucherBO", 1, 0, ""),
      sym("save", 10, 0, "VoucherBO"),
      sym("validate", 22, 0, "VoucherBO.save"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].sym.name).toBe("save");
    expect(tree[0].children[0].children[0].sym.name).toBe("validate");
  });

  it("同层多个类不会互相嵌套", () => {
    const tree = buildOutline([sym("A", 1), sym("a1", 2, 1), sym("B", 30), sym("b1", 31, 1)]);
    expect(tree.map((n) => n.sym.name)).toEqual(["A", "B"]);
    expect(tree[1].children[0].sym.name).toBe("b1");
  });
});

describe("filterOutline", () => {
  const tree = buildOutline([sym("VoucherBO", 1), sym("save", 10, 1), sym("check", 20, 1), sym("Other", 40)]);

  it("空查询原样返回", () => {
    expect(filterOutline(tree, "   ")).toBe(tree);
  });

  it("命中子项时保留祖先", () => {
    // 只留 save 会让它显示在最外层，看不出它属于哪个类
    const out = filterOutline(tree, "save");
    expect(out.map((n) => n.sym.name)).toEqual(["VoucherBO"]);
    expect(out[0].children.map((n) => n.sym.name)).toEqual(["save"]);
  });

  it("大小写不敏感", () => {
    expect(filterOutline(tree, "VOUCHER").map((n) => n.sym.name)).toEqual(["VoucherBO"]);
  });

  it("过滤后摊平的行缩进从 0 重新数", () => {
    const rows = outlineRows(filterOutline(tree, "check"));
    expect(rows.map((r) => [r.sym.name, r.depth])).toEqual([
      ["VoucherBO", 0],
      ["check", 1],
    ]);
  });
});

describe("moveActive", () => {
  it("到头就停住，不循环", () => {
    expect(moveActive(3, 2, 1)).toBe(2);
    expect(moveActive(3, 0, -1)).toBe(0);
  });

  it("没有行时返回 -1（回车不该跳任何地方）", () => {
    expect(moveActive(0, -1, 1)).toBe(-1);
  });
});
