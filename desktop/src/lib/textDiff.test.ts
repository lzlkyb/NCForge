import { describe, expect, it } from "vitest";
import { collapseDiff, countChanges, diffLines } from "./textDiff";

describe("diffLines", () => {
  it("相同文本全是 same 且行号两侧对齐", () => {
    const r = diffLines("a\nb\nc\n", "a\nb\nc\n");
    expect(r.tooBig).toBe(false);
    expect(r.rows.every((x) => x.op === "same")).toBe(true);
    expect(r.rows.map((x) => x.text)).toEqual(["a", "b", "c", ""]);
    expect(r.rows[1].oldLine).toBe(2);
    expect(r.rows[1].newLine).toBe(2);
  });

  it("纯增：旧版是新版前缀", () => {
    const r = diffLines("a\nb\n", "a\nb\nc\nd\n");
    const changed = r.rows.filter((x) => x.op !== "same");
    expect(changed.map((x) => x.op)).toEqual(["add", "add"]);
    expect(changed.map((x) => x.text)).toEqual(["c", "d"]);
    // add 行只有新行号，从第 3 行起
    expect(changed.map((x) => x.newLine)).toEqual([3, 4]);
    expect(changed.every((x) => x.oldLine === undefined)).toBe(true);
  });

  it("纯删", () => {
    const r = diffLines("a\nb\nc\n", "a\n");
    const changed = r.rows.filter((x) => x.op !== "same");
    expect(changed.map((x) => x.op)).toEqual(["del", "del"]);
    expect(changed.map((x) => x.text)).toEqual(["b", "c"]);
    expect(changed.map((x) => x.oldLine)).toEqual([2, 3]);
    expect(changed.every((x) => x.newLine === undefined)).toBe(true);
  });

  it("混合：中间改一行，前后不动", () => {
    const oldText = "head1\nhead2\nold-line\nmid\ntail1\ntail2\n";
    const newText = "head1\nhead2\nnew-line\nmid\ntail1\ntail2\n";
    const r = diffLines(oldText, newText);
    const changed = r.rows.filter((x) => x.op !== "same");
    expect(changed.map((x) => x.op)).toEqual(["del", "add"]);
    expect(changed.map((x) => x.text)).toEqual(["old-line", "new-line"]);
    // 公共前缀 2 行，被改的是第 3 行
    expect(changed[0].oldLine).toBe(3);
    expect(changed[1].newLine).toBe(3);
    // 公共后缀首行 "mid"：旧第 4 行 → 新第 4 行
    const mid = r.rows.find((x) => x.text === "mid");
    expect(mid?.oldLine).toBe(4);
    expect(mid?.newLine).toBe(4);
  });

  it("LCS 回溯：交换相邻两行不会整段重写", () => {
    const r = diffLines("x\nkeep\ny\n", "y\nkeep\nx\n");
    const changed = r.rows.filter((x) => x.op !== "same");
    // 最小编辑是 2 删 + 2 增；整段重写会是 3 删 + 3 增
    expect(changed.length).toBe(4);
  });

  it("行数超上限返回 tooBig", () => {
    const big = Array.from({ length: 4001 }, (_, i) => `l${i}`).join("\n");
    const r = diffLines(big, "small");
    expect(r.tooBig).toBe(true);
    expect(r.rows).toEqual([]);
  });

  it("中间段面积超上限返回 tooBig（前后缀相同但中间两段都大）", () => {
    // 公共前后缀各 1 行，中间两段各 2001 行且互不相同 → 面积 4_004_001 > 4_000_000
    const mk = (tag: string) =>
      ["head", ...Array.from({ length: 2001 }, (_, i) => `${tag}${i}`), "tail"].join("\n");
    const r = diffLines(mk("a"), mk("b"));
    expect(r.tooBig).toBe(true);
  });

  it("countChanges 只数 add/del", () => {
    const r = diffLines("a\nb\n", "a\nc\n");
    expect(countChanges(r.rows)).toEqual({ added: 1, removed: 1 });
  });
});

describe("collapseDiff", () => {
  it("没有任何改动 → 整段折成一个占位", () => {
    const r = diffLines("a\nb\nc\n", "a\nb\nc\n");
    const items = collapseDiff(r.rows);
    expect(items).toEqual([{ kind: "gap", count: 4 }]);
  });

  it("改动附近保留 context 行，远处折叠", () => {
    // 20 行，只改第 10 行（下标 9）
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const changed = [...lines];
    changed[9] = "CHANGED";
    const r = diffLines(lines.join("\n"), changed.join("\n"));
    const items = collapseDiff(r.rows, 2);
    const kept = items.filter((x) => x.kind === "row");
    // del l9 + add CHANGED 两行改动，加上下文各 2 行 = 6 行
    expect(kept.length).toBe(6);
    const gaps = items.filter((x) => x.kind === "gap");
    expect(gaps).toEqual([
      { kind: "gap", count: 7 }, // 前 7 行
      { kind: "gap", count: 8 }, // 后 8 行
    ]);
  });

  it("两处改动靠近时 context 重叠，中间不折叠", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const changed = [...lines];
    changed[4] = "X";
    changed[6] = "Y";
    const r = diffLines(lines.join("\n"), changed.join("\n"));
    const items = collapseDiff(r.rows, 2);
    // 4 处改动（del/add 各 2）连成一片，上下文并集 = 9 行，剩下 2+4 折两段
    expect(items.filter((x) => x.kind === "row").length).toBe(9);
    expect(items.filter((x) => x.kind === "gap").length).toBe(2);
  });

  it("context=0 时只留改动行本身", () => {
    const r = diffLines("a\nb\nc\n", "a\nB\nc\n");
    const items = collapseDiff(r.rows, 0);
    expect(items.filter((x) => x.kind === "row").length).toBe(2); // del b + add B
  });
});
