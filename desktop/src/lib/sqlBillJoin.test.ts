import { describe, expect, it, vi } from "vitest";

vi.mock("./sqlBusiness", () => ({ peekSqlBusinessMetadata: () => null, readSqlBusinessMetadata: async () => null }));

import { billJoinSpecs, billTableOf, sqlJoinIcon } from "./sqlBillJoin";
import type { SqlBusinessMetadata } from "./sqlBusiness";

const meta: SqlBusinessMetadata = {
  table: "po_order", schema: "nc65",
  relations: [{ id: "外键:FK_ORDER_B", source: "po_order_b", target: "po_order", from: ["pk_order"], to: ["pk_order"], kind: "外键" }],
  enums: [], partial: false, sharedSession: false,
};
const available = ["PO_ORDER", "PO_ORDER_B"];

it("图标区分真实视图、关联明细和已知 NC 对象，普通自定义表不按前缀猜", () => {
  expect(sqlJoinIcon("ORG_STOCKORG_V", "related", true)).toBe("view");
  expect(sqlJoinIcon("po_order_b", "detail", false)).toBe("detail");
  expect(sqlJoinIcon("SM_USER", "related", false)).toBe("user");
  expect(sqlJoinIcon("org_purchaseorg", "related", false)).toBe("org");
  expect(sqlJoinIcon("bd_supplier", "lookup", false)).toBe("book");
  expect(sqlJoinIcon("custom_v", "related", false)).toBe("table");
  expect(sqlJoinIcon("bd_custom", "lookup", false)).toBe("table");
});

describe("光标前的表名", () => {
  it("打全表名才认，半截前缀不猜", () => {
    expect(billTableOf("po_order", available, undefined, () => true)).toBe("po_order");
    expect(billTableOf("po_or", available, undefined, () => true)).toBe("");
  });

  it("中文名精确命中同样认出真实表名", () => {
    expect(billTableOf("采购订单", available, { po_order: "采购订单" }, () => true)).toBe("po_order");
  });

  it("需要加引号才成立的标识符不认：那种名字后端也查不到关系", () => {
    expect(billTableOf("po_order", available, undefined, () => false)).toBe("");
  });
});

describe("表名末尾的 JOIN 片段", () => {
  it("按关联列生成 LEFT JOIN，表名列名统一小写", () => {
    expect(billJoinSpecs("po_order", available, meta)).toEqual([
      { table: "po_order_b", sql: " LEFT JOIN po_order_b ON po_order_b.pk_order = po_order.pk_order", source: "外键 · FK_ORDER_B", group: "detail", rootColumns: ["pk_order"], otherColumns: ["pk_order"] },
    ]);
  });

  it("复合关联列用 AND 串起来", () => {
    const composite = { ...meta, relations: [{ ...meta.relations[0], from: ["pk_order", "bill_type"], to: ["pk_order", "bill_type"] }] };
    expect(billJoinSpecs("po_order", available, composite)[0].sql)
      .toBe(" LEFT JOIN po_order_b ON po_order_b.pk_order = po_order.pk_order AND po_order_b.bill_type = po_order.bill_type");
  });

  it("关系还没读到时不给片段", () => {
    expect(billJoinSpecs("po_order", available, null)).toEqual([]);
  });

  it("已确认的单据明细优先，其他业务引用与档案都保留，只有相似的表名不能生成联查", () => {
    const other = ["order_income", "order_tax", "order_version", "order_history", "order_delivery", "order_profit", "order_billing", "bd_tradetype"];
    const relations = [...other.map(table => ({ ...meta.relations[0], id: `外键:${table}`, source: table })), ...meta.relations];
    const specs = billJoinSpecs("po_order", [...available, ...other, "PO_ORDER_DETAIL"], { ...meta, relations });
    expect(specs.map(({table}) => table)).toEqual(["po_order_b", ...other]);
    expect(specs[0].group).toBe("detail");
    expect(specs[specs.length - 1]?.group).toBe("lookup");
  });
});
