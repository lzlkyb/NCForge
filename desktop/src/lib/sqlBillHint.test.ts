// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const meta = {
  table: "po_order", schema: "nc65",
  relations: [{ id: "外键 · FK_ORDER_B", source: "po_order_b", target: "po_order", from: ["pk_order"], to: ["pk_order"], kind: "外键" }],
  enums: [], partial: false, sharedSession: false,
};
const peek = vi.hoisted(() => vi.fn());
vi.mock("./sqlBusiness", () => ({ peekSqlBusinessMetadata: peek, readSqlBusinessMetadata: async () => null }));

import { billLinkHint, sqlTableDescription } from "./sqlBillHint";

const input = (over: Partial<Parameters<typeof sqlTableDescription>[0]> = {}) => ({
  zh: "采购订单", view: false, why: "最近使用", connId: "c1", scope: "s1", prefix: "po_order", name: "po_order",
  available: ["PO_ORDER", "PO_ORDER_B"], ...over,
});

describe("表名补全项的主子表说明", () => {
  beforeEach(() => peek.mockClear());

  it("表名完整打出、且已读到关系时才标注", () => {
    peek.mockReturnValue(meta);
    expect(sqlTableDescription(input())).toBe("采购订单 · 最近使用 · 1 个关联表 · 支持主子表联查");
  });

  it("只打了前缀不算：几千张表的列表里逐项查关联会退化成 O(n²)", () => {
    peek.mockReturnValue(meta);
    expect(sqlTableDescription(input({ prefix: "po" }))).toBe("采购订单 · 最近使用");
    expect(peek).toHaveBeenCalledTimes(0);
  });

  it("关系还没读到时什么都不说，不写「支持联查」这种没把握的话", () => {
    peek.mockReturnValue(null);
    expect(sqlTableDescription(input())).toBe("采购订单 · 最近使用");
  });

  it("有关联记录但都指向不存在的表，也不算能联查", () => {
    peek.mockReturnValue({ ...meta, relations: [{ ...meta.relations[0], source: "gone_table" }] });
    expect(billLinkHint("c1", "s1", "po_order", ["PO_ORDER"])).toBe("");
  });

  it("中文名精确命中同样触发标注", () => {
    peek.mockReturnValue(meta);
    expect(sqlTableDescription(input({ prefix: "采购订单" }))).toContain("支持主子表联查");
  });
});
