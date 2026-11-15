import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { computeChanged } from "./changedLines";
import { blockOrigins } from "./blockOwners";
import { blockInfos, blocksForReq, rememberOrigins, resetBlockState, statsIn, stripState } from "./blockState";
import { markBlockReviewed, markBlocksReviewed, priorReview, resetReviewSession } from "./reviewSession";
import type { FileReqs, Touch } from "./requirements";

const L = (...lines: string[]) => lines.join("\n");
const ai = (seq: number, req: string | null, beforeSha: string, afterSha: string): Touch =>
  ({ req, atMs: seq * 1000, source: "ai", op: "edit", beforeSha, afterSha, backup: "b", seq });
const PATH = "C:/w/A.java";
const base = L("a", "b", "c", "d", "e");
const v1 = L("a", "B", "c", "d", "e");
const cur = L("a", "B", "c", "D", "e");
const touches = [ai(1, "A", "s0", "s1"), ai(2, "B", "s1", "s2")];
const file: FileReqs = { path: PATH, reqs: ["A", "B"], claimed: false, touches };
const fv = { workingSha: "s2", versions: [{ seq: 1, text: base }, { seq: 2, text: v1 }] };

function setup(working = cur) {
  const blocks = computeChanged(base, working).blocks;
  const origins = blockOrigins(blocks, touches, fv, working);
  return { blocks, origins, infos: () => blockInfos(PATH, blocks, origins, file) };
}

describe("blockState", () => {
  beforeEach(() => { resetReviewSession(); resetBlockState(); });

  it("别的需求 > 已审 > 来源；不分需求时没有「别的需求」", () => {
    const s = setup();
    expect(s.infos().map((i) => i.reqs)).toEqual([["A"], ["B"]]);
    expect(s.infos().map((i) => stripState(i, "A"))).toEqual(["ai", "other"]);
    expect(s.infos().map((i) => stripState(i, null))).toEqual(["ai", "ai"]);
    markBlockReviewed(PATH, s.blocks[1], true);
    expect(stripState(s.infos()[1], "A")).toBe("other");
    expect(stripState(s.infos()[1], "B")).toBe("reviewed");
  });

  it("按需求数块", () => {
    const s = setup();
    markBlockReviewed(PATH, s.blocks[0], true);
    expect(statsIn(s.infos(), "A")).toEqual({ total: 1, done: 1, redo: 0 });
    expect(statsIn(s.infos(), "B")).toEqual({ total: 1, done: 0, redo: 0 });
    expect(statsIn(s.infos(), null)).toEqual({ total: 2, done: 1, redo: 0 });
  });

  it("审完后同一段基线上又改了 = 需重审，带着当时审过的文本；取消已审不算", () => {
    const s = setup();
    markBlockReviewed(PATH, s.blocks[1], true);
    const again = computeChanged(base, L("a", "B", "c", "DD", "e")).blocks;
    expect(priorReview(PATH, again[1])?.text).toBe("D");
    expect(priorReview(PATH, again[0])).toBeNull();
    const infos = blockInfos(PATH, again, s.origins, file);
    expect(stripState(infos[1], "B")).toBe("redo");
    expect(statsIn(infos, "B")).toEqual({ total: 1, done: 0, redo: 1 });
    markBlockReviewed(PATH, s.blocks[1], false);
    expect(priorReview(PATH, again[1])).toBeNull();
  });

  it("批量标记也记下基线区间", () => {
    const s = setup();
    markBlocksReviewed(PATH, s.blocks, true);
    const moved = computeChanged(base, L("a", "BB", "c", "D", "e")).blocks;
    expect(priorReview(PATH, moved[0])?.range).toEqual([2, 2]);
  });

  it("只标本需求的块：用记住的归属；块对不上或没记住就全部", () => {
    const s = setup();
    expect(blocksForReq(PATH, s.blocks, "A", file)).toHaveLength(2);
    rememberOrigins(PATH, s.blocks, s.origins);
    expect(blocksForReq(PATH, s.blocks, "A", file)).toEqual([s.blocks[0]]);
    expect(blocksForReq(PATH, s.blocks, "-", file)).toHaveLength(2);
    expect(blocksForReq(PATH, s.blocks, null, file)).toHaveLength(2);
    const other = computeChanged(base, L("a", "X", "c", "D", "e")).blocks;
    expect(blocksForReq(PATH, other, "A", file)).toHaveLength(2);
  });
});
