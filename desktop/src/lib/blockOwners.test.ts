import { describe, expect, it } from "vitest";
import { blockInReq, blockOrigins, blockReqs, latestTouch, type FileVersions } from "./blockOwners";
import { computeChanged } from "./changedLines";
import type { FileReqs, Touch } from "./requirements";

const ai = (seq: number, req: string | null, beforeSha: string | null, afterSha: string | null, atMs = seq * 1000): Touch =>
  ({ req, atMs, source: "ai", op: "edit", reason: `原因${seq}`, beforeSha, afterSha, backup: "bak", seq });
const manual = (atMs: number, req: string | null): Touch => ({ req, atMs, source: "manual", op: "edit", seq: 0 });
const L = (...lines: string[]) => lines.join("\n");

function origins(base: string, working: string, touches: Touch[], fv: FileVersions | null) {
  const blocks = computeChanged(base, working).blocks;
  return { blocks, origins: blockOrigins(blocks, touches, fv, working) };
}
const reqsOf = (o: { touches: Touch[] }) => o.touches.map((t) => t.req ?? (t.source === "manual" ? "手改" : "未声明"));

describe("blockOrigins 逐行归属", () => {
  const base = L("package x;", "int a = 1;", "int b = 2;", "int c = 3;", "int d = 4;", "int e = 5;");
  const v1 = L("package x;", "int a = 10;", "int b = 2;", "int c = 3;", "int d = 4;", "int e = 5;");
  const v2 = L("package x;", "int a = 10;", "int b = 2;", "int c = 3;", "int d = 40;", "int e = 5;");

  it("两个需求先后改同一文件：各归各的", () => {
    const touches = [ai(1, "A", "s0", "s1"), ai(2, "B", "s1", "s2")];
    const fv = { workingSha: "S2", versions: [{ seq: 1, text: base }, { seq: 2, text: v1 }] };
    const r = origins(base, v2, touches, fv);
    expect(r.blocks).toHaveLength(2);
    expect(r.origins.map(reqsOf)).toEqual([["A"], ["B"]]);
    expect(r.origins.every((o) => !o.unknown && !o.fileLevel)).toBe(true);
  });

  describe("两次写入之间有手改", () => {
    const hand = L("package x;", "int a = 10;", "int b = 2;", "int c = 30;", "int d = 4;", "int e = 5;");
    const v2h = hand.replace("int d = 4;", "int d = 40;");
    const touches = [ai(1, "A", "s0", "s1", 1000), manual(1500, "C"), ai(2, "B", "sX", "s2", 2000)];
    const versions = [{ seq: 1, text: base.replace(/\n/g, "\r\n") }, { seq: 2, text: hand }];

    it("本地历史里有第一次写入后的内容：空档里的改动单独归手改，CRLF 不影响", () => {
      const r = origins(base, v2h, touches, { workingSha: "s2", versions, known: [{ sha: "S1", text: v1 }] });
      // 第 4、5 行相邻，合成一个块：一半手改、一半 B
      expect(r.origins.map(reqsOf)).toEqual([["A"], ["C", "B"]]);
    });

    it("没有：第一次写入与手改合成一步，两个来源都算（宁可多审不漏）", () => {
      const r = origins(base, v2h, touches, { workingSha: "s2", versions });
      expect(r.origins.map(reqsOf)).toEqual([["A", "C"], ["A", "C", "B"]]);
    });
  });

  it("纯删除的块靠墓碑知道是谁删的", () => {
    const del = L("package x;", "int a = 10;", "int b = 2;", "int d = 4;", "int e = 5;");
    const touches = [ai(1, "A", "s0", "s1"), ai(2, "B", "s1", "s2")];
    const fv = { workingSha: "s2", versions: [{ seq: 1, text: base }, { seq: 2, text: v1 }] };
    const r = origins(base, del, touches, fv);
    expect(r.blocks.map((b) => b.removed)).toEqual([1, 1]);
    expect(r.origins.map(reqsOf)).toEqual([["A"], ["B"]]);
  });

  it("写入后的内容还原不出来：这次写入与之后的手改合并算来源", () => {
    const touches = [ai(1, "A", "s0", "对不上", 1000), manual(1500, null)];
    const fv = { workingSha: "s9", versions: [{ seq: 1, text: base }] };
    const r = origins(base, v1, touches, fv);
    expect(r.origins.map(reqsOf)).toEqual([["A", "手改"]]);
  });

  it("版本链起点之前就有的改动：没有更早的触达就是来源不明", () => {
    const touches = [ai(2, "B", "s1", "s2")];
    const fv = { workingSha: "s2", versions: [{ seq: 2, text: v1 }] };
    const r = origins(base, v2, touches, fv);
    expect(r.origins[0]).toMatchObject({ touches: [], unknown: true });
    expect(reqsOf(r.origins[1])).toEqual(["B"]);
  });

  it("新建文件：写入前内容为空串，整篇归新建它的需求", () => {
    const touches = [ai(1, "A", null, "s1"), ai(2, "B", "s1", "s2")];
    const fv = { workingSha: "s2", versions: [{ seq: 1, text: "" }, { seq: 2, text: L("a", "b") }] };
    const r = origins("", L("a", "b", "c"), touches, fv);
    expect(r.blocks).toHaveLength(1);
    expect(reqsOf(r.origins[0]).sort()).toEqual(["A", "B"]);
  });

  it("块里既有实质行又有纯括号行时，只看实质行的来源", () => {
    // 起点里已经有一个「更早的」多余 `}`（来源不明），AI 又紧挨着加了一行：两行合成一个块，归 AI。
    const b0 = L("class X {", "  void f() {", "  }", "}");
    const start = L("class X {", "  void f() {", "  }", "  }", "}");
    const b1 = L("class X {", "  void f() {", "  }", "  }", "  int k = 1;", "}");
    const fv = { workingSha: "s1", versions: [{ seq: 1, text: start }] };
    const r = origins(b0, b1, [ai(1, "A", "s0", "s1")], fv);
    expect(r.blocks).toHaveLength(1);
    expect(r.origins[0]).toMatchObject({ unknown: false });
    expect(reqsOf(r.origins[0])).toEqual(["A"]);
  });
});

describe("退回文件级", () => {
  it("没有任何可用版本 / 没有版本数据", () => {
    const t = [ai(1, "A", "s0", "s1"), manual(5, "B")];
    const a = origins("x", "y", t, { workingSha: null, versions: [{ seq: 1, text: null }] });
    expect(a.origins[0]).toMatchObject({ fileLevel: true, unknown: false });
    expect(reqsOf(a.origins[0])).toEqual(["A", "B"]);
    expect(origins("x", "y", [], null).origins[0]).toMatchObject({ fileLevel: true, unknown: true });
  });
});

describe("blockReqs / blockInReq / latestTouch", () => {
  const file = (reqs: string[], claimed = false): FileReqs => ({ path: "C:/w/A.java", reqs, claimed, touches: [] });
  const o = (touches: Touch[], unknown = false) => ({ touches, unknown, fileLevel: false });
  it("来源里的需求优先；说不清的块算本文件全部需求；认领覆盖一切", () => {
    expect(blockReqs(o([ai(1, "A", null, null)]), file(["A", "B"]))).toEqual(["A"]);
    expect(blockInReq(o([ai(1, "A", null, null)]), file(["A", "B"]), "B")).toBe(false);
    expect(blockReqs(o([ai(1, null, null, null)]), file(["A", "B"]))).toEqual(["A", "B"]);
    expect(blockReqs(o([], true), file(["A", "B"]))).toEqual(["A", "B"]);
    expect(blockReqs(o([ai(1, "已关闭", null, null)]), file(["A"]))).toEqual(["A"]);
    expect(blockReqs(o([ai(1, "B", null, null)]), file(["A"], true))).toEqual(["A"]);
    expect(blockInReq(o([]), undefined, "A")).toBe(true);
  });
  it("最近的触达", () => {
    expect(latestTouch(o([ai(1, "A", null, null, 5), manual(9, null), ai(2, "B", null, null, 7)]))?.source).toBe("manual");
    expect(latestTouch(o([]))).toBeNull();
  });
});
