import { describe, expect, it } from "vitest";
import { planBlocker, planNote, type TransferPlan } from "./transferPlan";

const base: TransferPlan = {
  pairs: [{ from: "ID", to: "ID", ty: "NUMBER" }],
  skipped: [],
  extra: [],
  lobs: [],
};

describe("planBlocker", () => {
  it("没算映射前先挡住：不允许「先按了再说」", () => {
    expect(planBlocker(null)).toContain("先算一遍映射");
  });

  it("没有共同列时挡住，并指向结构对比", () => {
    expect(planBlocker({ ...base, pairs: [] })).toContain("对比结构");
  });

  it("有 LOB 列时挡住整次搬运，并点名是哪几列", () => {
    const msg = planBlocker({ ...base, lobs: ["ATTACH", "NOTE"] });
    expect(msg).toContain("ATTACH、NOTE");
    // 必须说清「会被截断」而不是含糊的「不支持」，否则用户会以为只是慢
    expect(msg).toContain("8K");
  });

  it("正常计划返回 null", () => {
    expect(planBlocker(base)).toBeNull();
  });
});

describe("planNote", () => {
  it("列数、源独有、目标独有都写在同一行", () => {
    const note = planNote({ ...base, skipped: ["MEMO"], extra: ["OLD"] });
    expect(note).toContain("搬 1 列");
    expect(note).toContain("源表另有 1 列目标没有");
    expect(note).toContain("目标表另有 1 列会写 NULL");
  });

  it("没有差异时只报列数，不堆废话", () => {
    expect(planNote(base)).toBe("搬 1 列");
  });
});
