import { expect, it, vi } from "vitest";
import { sqlQuickFixes } from "./sqlQuickFix";

it("replaces a single invalid column token using columns of the resolved table", async () => {
  const sql = "select p.vbillcod from po_order p where p.label = 'vbillcod'";
  const columns = vi.fn().mockResolvedValue(["VBILLCODE", "LABEL"]);
  const fixes = await sqlQuickFixes('ORA-00904: "VBILLCOD": invalid identifier', sql, ["PO_ORDER"], columns);
  expect(columns).toHaveBeenCalledWith("po_order");
  expect(fixes).toEqual([{ start: 9, end: 17, text: "vbillcode" }]);
});

it("suggests local table corrections and skips qualified or ambiguous targets", async () => {
  const columns = vi.fn();
  expect(await sqlQuickFixes("ORA-00942", "select * from po_orde", ["PO_ORDER"], columns))
    .toEqual([{ start: 14, end: 21, text: "po_order" }]);
  expect(await sqlQuickFixes("ORA-00942", "select * from other.po_orde", ["PO_ORDER"], columns)).toEqual([]);
  expect(await sqlQuickFixes('ORA-00904: "VBILLCOD": invalid identifier',
    "select vbillcod from po_order join other_order on 1=1", ["PO_ORDER", "OTHER_ORDER"], columns)).toEqual([]);
  expect(columns).not.toHaveBeenCalled();
});

it("offers explicit qualifiers for one ambiguous column without choosing a source", async () => {
  const fixes = await sqlQuickFixes("ORA-00918", "select id from a x join b y on x.id=y.id", ["A", "B"], async () => ["ID"]);
  expect(fixes.map(fix => fix.text)).toEqual(["x.id", "y.id"]);
});

// ORA-00904 覆盖面回归（2026-11-19 延伸：多处同名错列与引号标识符）。
const cols = async () => ["VBILLCODE", "LABEL", "PK_ORDER"];

it("ORA-00904：未限定单表列名给相似列修复", async () => {
  const fixes = await sqlQuickFixes('ORA-00904: "VBILLCOD": invalid identifier', "select vbillcod from po_order", ["PO_ORDER"], cols);
  expect(fixes).toEqual([{ start: 7, end: 15, text: "vbillcode" }]);
});

it("ORA-00904：同一错列名出现多处，每处各给修复", async () => {
  const fixes = await sqlQuickFixes('ORA-00904: "VBILLCOD": invalid identifier', "select vbillcod from po_order where vbillcod = 'x'", ["PO_ORDER"], cols);
  expect(fixes.map(f => [f.start, f.end])).toEqual([[7, 15], [36, 44]]);
  expect(fixes.every(f => f.text === "vbillcode")).toBe(true);
});

it("ORA-00904：引号标识符同样可修", async () => {
  const fixes = await sqlQuickFixes('ORA-00904: "VBILLCOD": invalid identifier', 'select "VBILLCOD" from po_order', ["PO_ORDER"], cols);
  expect(fixes).toEqual([{ start: 7, end: 17, text: "vbillcode" }]);
});

it("ORA-00904 反例：列名其实存在、错误词是表名、多表未限定，都不给修复", async () => {
  expect(await sqlQuickFixes('ORA-00904: "LABEL": invalid identifier', "select label from po_order", ["PO_ORDER"], cols)).toEqual([]);
  expect(await sqlQuickFixes('ORA-00904: "PO_ORDER": invalid identifier', "select * from po_order", ["PO_ORDER"], cols)).toEqual([]);
  const columns = vi.fn();
  expect(await sqlQuickFixes('ORA-00904: "VBILLCOD": invalid identifier', "select vbillcod from po_order join po_order_b on 1=1", ["PO_ORDER", "PO_ORDER_B"], columns)).toEqual([]);
  expect(columns).not.toHaveBeenCalled();
});

it("ORA-00904：字符串里的同名词不被当成错列位置", async () => {
  const fixes = await sqlQuickFixes('ORA-00904: "VBILLCOD": invalid identifier', "select 'vbillcod' from po_order where vbillcod = 1", ["PO_ORDER"], cols);
  expect(fixes).toEqual([{ start: 38, end: 46, text: "vbillcode" }]);
});

it("ORA-00904：几十处错列名时候选封顶，不堆爆错误框", async () => {
  const where = Array.from({ length: 40 }, (_, i) => `vbillcod = ${i}`).join(" or ");
  const fixes = await sqlQuickFixes('ORA-00904: "VBILLCOD": invalid identifier', `select vbillcod from po_order where ${where}`, ["PO_ORDER"], cols);
  expect(fixes.length).toBeLessThanOrEqual(12);
  expect(fixes.length).toBeGreaterThan(0);
  expect(fixes.every(f => f.text === "vbillcode")).toBe(true);
});
