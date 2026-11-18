// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  meta: null as null | Record<string, unknown>,
  columns: {
    po_order: [{ name: "vbillcode", full: "VARCHAR2(40)", pk: false }, { name: "pk_order", full: "CHAR(20)", pk: true }],
    po_order_b: [{ name: "pk_order", full: "CHAR(20)", pk: false }],
  } as Record<string, { name: string; full: string; pk: boolean }[]>,
  reads: [] as string[],
  failNext: false,
}));

vi.mock("./sqlBusiness", () => ({
  peekSqlBusinessMetadata: () => h.meta,
  readSqlBusinessMetadata: async (_c: string, _s: string, table: string) => {
    h.reads.push(table);
    if (h.failNext) { h.failNext = false; throw new Error("boom"); }
    return h.meta;
  },
}));
vi.mock("./sqlAssistLearning", () => ({ sqlAssistScope: () => "scope" }));
vi.mock("./sqlAssistColumns", () => ({ sqlAssistColumns: async (_c: string, table: string) => h.columns[table] ?? [] }));
vi.mock("./sqlFormatPrefs", () => ({ getSqlFormatPrefs: () => ({ keywordCase: "upper" }) }));
vi.mock("./sqlBillHint", () => ({ plainName: (name: string) => name.toLowerCase() }));
vi.mock("./dbStore", () => ({
  connOf: () => ({ id: "c1" }),
  rtOf: () => ({ status: "connected", currentSchema: "nc65", info: { schema: "nc65" },
    tables: [{ name: "po_order" }, { name: "po_order_b" }, { name: "po_order_c" }], ncNames: { po_order: "采购订单", po_order_b: "采购订单明细", po_order_c: "采购订单尾差" } }),
}));

import { canDeepDive, planDeepDive, relationHintOf, warmResultRelations } from "./resultRelationHint";

beforeEach(() => {
  // 用例之间会改列夹具（如「主表没有 vbillcode」），这里逐条复位，避免跨用例污染
  h.columns.po_order = [{ name: "vbillcode", full: "VARCHAR2(40)", pk: false }, { name: "pk_order", full: "CHAR(20)", pk: true }];
  h.columns.po_order_b = [{ name: "pk_order", full: "CHAR(20)", pk: false }];
  h.meta = {
    table: "po_order", schema: "nc65", partial: false, sharedSession: false, enums: [],
    relations: [{ id: "外键 · FK_ORDER_B", source: "po_order_b", target: "po_order", from: ["pk_order"], to: ["pk_order"], kind: "外键" }],
  } as never;
});

it("关系已读到才给提示，没读到整个不显示", () => {
  expect(relationHintOf("c1", "po_order")).toEqual({ table: "po_order", count: 1 });
  h.meta = null;
  expect(relationHintOf("c1", "po_order")).toBeNull();
  // 没有关联表的表（元数据在但关系空）同样不提示
  h.meta = { table: "bd_org", schema: "nc65", partial: false, sharedSession: false, enums: [], relations: [] } as never;
  expect(relationHintOf("c1", "po_order")).toBeNull();
  // 空表名 / 空连接直接不出
  expect(relationHintOf("c1", "")).toBeNull();
  expect(relationHintOf(null, "po_order")).toBeNull();
});

it("能生成联查 SQL：填入编辑器即可，不自动执行", async () => {
  const plan = await planDeepDive({ connId: "c1", table: "po_order", line: 3 });
  expect(plan.kind).toBe("sql");
  if (plan.kind !== "sql") return;
  expect(plan.sql).toContain("FROM po_order a");
  expect(plan.sql).toContain("LEFT JOIN po_order_b b");
  expect(plan.sql).toContain("ON a.pk_order = b.pk_order");
});

it("生成不了就退回定位：关系空、列读不到、主表没有 vbillcode 三条路都走得通", async () => {
  h.meta = null;
  expect(await planDeepDive({ connId: "c1", table: "po_order", line: 7 })).toEqual({ kind: "locate", line: 7 });
  h.meta = { table: "po_order", schema: "nc65", partial: false, sharedSession: false, enums: [], relations: [] } as never;
  expect(await planDeepDive({ connId: "c1", table: "po_order", line: 7 })).toEqual({ kind: "locate", line: 7 });
  // 主表列读不到（没有 vbillcode 时 billQueryTemplates 返回空）
  h.meta = {
    table: "po_order", schema: "nc65", partial: false, sharedSession: false, enums: [],
    relations: [{ id: "外键 · FK_ORDER_B", source: "po_order_b", target: "po_order", from: ["pk_order"], to: ["pk_order"], kind: "外键" }],
  } as never;
  h.columns.po_order = [{ name: "pk_order", full: "CHAR(20)", pk: true }];
  expect(await planDeepDive({ connId: "c1", table: "po_order", line: 7 })).toEqual({ kind: "locate", line: 7 });
});

it("子表列读不到只少一张关联，剩下的照样生成", async () => {
  h.columns.po_order_c = [{ name: "pk_order", full: "CHAR(20)", pk: false }];
  h.meta = {
    table: "po_order", schema: "nc65", partial: false, sharedSession: false, enums: [],
    relations: [
      { id: "外键 · FK_ORDER_B", source: "po_order_b", target: "po_order", from: ["pk_order"], to: ["pk_order"], kind: "外键" },
      { id: "外键 · FK_ORDER_C", source: "po_order_c", target: "po_order", from: ["pk_order"], to: ["pk_order"], kind: "外键" },
    ],
  } as never;
  h.columns.po_order_b = [];
  const plan = await planDeepDive({ connId: "c1", table: "po_order", line: 1 });
  expect(plan.kind).toBe("sql");
  if (plan.kind !== "sql") return;
  expect(plan.sql).toContain("LEFT JOIN po_order_c b");
  expect(plan.sql).not.toContain("po_order_b");
});

it("连接断开时不给深挖", () => {
  expect(canDeepDive("c1")).toBe(true);
  expect(canDeepDive(null)).toBe(false);
});

it("预热：快照里已有不读，没有才读一次；读失败不炸且清掉记录", async () => {
  h.reads = [];
  // beforeEach 的快照里有 po_order：直接命中，不发起读取
  await warmResultRelations("c1", "po_order");
  expect(h.reads).toEqual([]);
  h.meta = null;
  await warmResultRelations("c1", "po_order");
  expect(h.reads).toEqual(["po_order"]);
  // 同一张表第二次：去重
  await warmResultRelations("c1", "po_order");
  expect(h.reads).toEqual(["po_order"]);
  // 读失败：不抛出，记录清掉，下次重挂这个结果视图还会再读
  h.failNext = true;
  await expect(warmResultRelations("c1", "po_order_b")).resolves.toBeUndefined();
  expect(h.reads).toEqual(["po_order", "po_order_b"]);
  await warmResultRelations("c1", "po_order_b");
  expect(h.reads).toEqual(["po_order", "po_order_b", "po_order_b"]);
  // 空连接 / 空表名：不读
  await warmResultRelations(null, "po_order");
  await warmResultRelations("c1", "");
  expect(h.reads).toHaveLength(3);
});
