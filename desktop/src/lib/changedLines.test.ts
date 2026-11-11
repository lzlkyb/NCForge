import { describe, expect, it } from "vitest";
import { blockAtLine, computeChanged, EMPTY_CHANGED, isChangedLine, normalizeEol } from "./changedLines";

describe("computeChanged", () => {
  it("没有改动时是空快照", () => {
    const s = computeChanged("a\nb\nc\n", "a\nb\nc\n");
    expect(s.blocks).toEqual([]);
    expect(s.added).toBe(0);
    expect(s.removed).toBe(0);
    expect(s.tooBig).toBe(false);
  });

  it("掐掉公共前后缀后只报中间那一块", () => {
    const base = "h1\nh2\nold\nmid\nt1\nt2\n";
    const cur = "h1\nh2\nnew\nmid\nt1\nt2\n";
    const s = computeChanged(base, cur);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ startLine: 3, endLine: 3, added: 1, removed: 1, deletedAt: 3 });
    expect(s.blocks[0].baseLines).toEqual(["old"]);
    expect(s.blocks[0].currentLines).toEqual(["new"]);
    expect(s.touchedLines).toEqual([3]);
  });

  it("纯新增：基线里没有这些行，还原目标为空", () => {
    const s = computeChanged("a\nb\n", "a\nb\nc\nd\n");
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ startLine: 3, endLine: 4, added: 2, removed: 0, deletedAt: 0 });
    expect(s.blocks[0].baseLines).toEqual([]);
    expect(s.addedLines).toEqual([3, 4]);
  });

  it("纯删除：没有新侧行，删除三角挂在插入点", () => {
    const s = computeChanged("a\nb\nc\nd\n", "a\nd\n");
    expect(s.blocks).toHaveLength(1);
    const b = s.blocks[0];
    expect(b).toMatchObject({ startLine: 2, endLine: 1, added: 0, removed: 2, deletedAt: 2 });
    expect(b.baseLines).toEqual(["b", "c"]);
    expect(b.currentLines).toEqual([]);
    expect(b.deletedAt).toBeGreaterThan(b.endLine);
  });

  it("新增文件（BASE 为空）整篇算新增，不会多出一条假的删除", () => {
    const s = computeChanged("", "a\nb\n");
    expect(s.added).toBe(3);
    expect(s.removed).toBe(0);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0].baseLines).toEqual([]);
    expect(s.addedLines).toEqual([1, 2, 3]);
  });

  it("空文件对空文件不产生改动", () => {
    expect(computeChanged("", "")).toBe(EMPTY_CHANGED);
  });

  it("CRLF 基线与 LF 模型不会整篇假差异", () => {
    const s = computeChanged("a\r\nb\r\nc\r\n", "a\nb\nc\n");
    expect(s.blocks).toEqual([]);
    expect(normalizeEol("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("GBK 中文注释按行比较，行号与编辑器一致", () => {
    const base = "// 凭证管理\npublic class A {}\n";
    const cur = "// 凭证管理\npublic class A {\n  int n;\n}\n";
    const s = computeChanged(base, cur);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0].startLine).toBe(2);
    expect(s.blocks[0].added).toBe(3);
  });

  it("超过 4000 行/侧直接降级 tooBig，不算 diff", () => {
    const big = Array.from({ length: 4002 }, (_, i) => `line ${i}`).join("\n");
    const s = computeChanged(big, big + "\nextra");
    expect(s.tooBig).toBe(true);
    expect(s.blocks).toEqual([]);
  });

  it("多块时行号逐块递增，touchedLines 去重排序", () => {
    const s = computeChanged("a\nb\nc\nd\ne\nf\n", "A\nb\nc\nD\ne\nF\n");
    expect(s.blocks.map((b) => b.startLine)).toEqual([1, 4, 6]);
    expect(s.added).toBe(3);
    expect(s.removed).toBe(3);
    expect(s.touchedLines).toEqual([1, 4, 6]);
  });
});

describe("blockAtLine / isChangedLine", () => {
  const s = computeChanged("a\nb\nc\nd\n", "a\nB\nc\nd\n");

  it("改动行能找回对应块", () => {
    expect(blockAtLine(s, 2)?.currentLines).toEqual(["B"]);
  });

  it("未改动的行找不回块", () => {
    expect(blockAtLine(s, 1)).toBeUndefined();
    expect(isChangedLine(s, 1)).toBe(false);
    expect(isChangedLine(s, 2)).toBe(true);
  });

  it("纯删除块的删除标记行也能点开", () => {
    const d = computeChanged("a\nb\nc\nd\n", "a\nd\n");
    expect(blockAtLine(d, 2)?.baseLines).toEqual(["b", "c"]);
  });
});
