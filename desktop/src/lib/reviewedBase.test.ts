import { describe, expect, it } from "vitest";
import { computeChanged } from "./changedLines";
import { reviewedBase } from "./reviewedBase";

const L = (...lines: string[]) => lines.join("\n");

describe("reviewedBase", () => {
  const base = L("a", "b", "c", "d", "e", "f");
  const cur = L("a", "B", "c", "d", "x", "e", "f");
  const blocks = computeChanged(base, cur).blocks;

  it("已审的块并进左侧后，差异只剩没审的块", () => {
    expect(blocks).toHaveLength(2);
    const left = reviewedBase(base, blocks, (b) => b === blocks[0]);
    expect(left).toBe(L("a", "B", "c", "d", "e", "f"));
    const rest = computeChanged(left, cur).blocks;
    expect(rest).toHaveLength(1);
    expect(rest[0].currentLines).toEqual(["x"]);
  });

  it("都没审 = BASE；都审了 = 当前；CRLF 归一", () => {
    expect(reviewedBase(base.replace(/\n/g, "\r\n"), blocks, () => false)).toBe(base);
    expect(reviewedBase(base, blocks, () => true)).toBe(cur);
  });

  it("删除块与新增文件", () => {
    const del = computeChanged(base, L("a", "b", "e", "f")).blocks;
    expect(reviewedBase(base, del, () => true)).toBe(L("a", "b", "e", "f"));
    const created = computeChanged("", L("x", "y")).blocks;
    expect(reviewedBase("", created, () => true)).toBe(L("x", "y"));
    expect(reviewedBase("", created, () => false)).toBe("");
  });
});
