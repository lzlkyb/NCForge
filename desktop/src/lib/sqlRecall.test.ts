import { expect, it } from "vitest";
import { recallSql } from "./sqlRecall";

it("按中文业务名找回当前 schema 的模板、固定与成功查询", () => {
  const row = { at: 1, ms: 1, ok: true, summary: "1 行", sql: "select * from po_order", schema: "APP" };
  const hits = recallSql({
    c: [{ ...row, pinned: true }, { ...row, at: 20, schema: "OTHER" }, { ...row, at: 3 }, { ...row, ok: false, at: 4 }],
    other: [{ ...row, at: 30 }],
  }, [{ id: "s", connId: "c", at: 2, name: "按单号查", sql: "select * from po_order where code = :bill_no" }],
  { connId: "c", schema: "APP", all: true, failed: false, query: "采购订单", names: { po_order: "采购订单" } });
  expect(hits.map(h => [h.kind, h.entry.at])).toEqual([["history", 1], ["template", 2], ["history", 3], ["history", 4]]);
});

it("does not match Chinese names through literals or tables in a different schema", () => {
  const row = { at: 1, ms: 1, ok: true, summary: "1 行" };
  const result = recallSql({ c: [
    { ...row, sql: "select 'from po_order' from dual" },
    { ...row, sql: "select * from other.po_order" },
    { ...row, sql: "select * from app.po_order" },
  ] }, [], { connId: "c", schema: "APP", all: false, failed: false, query: "采购订单", names: { po_order: "采购订单" } });
  expect(result.map(hit => hit.sql)).toEqual(["select * from app.po_order"]);
});
