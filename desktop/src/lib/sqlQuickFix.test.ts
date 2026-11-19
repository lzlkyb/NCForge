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

// ORA-00942 跨 schema 探查（locate）：current_schema 错位是「别的工具能跑、这里 942」的头号原因。
const loc = (objects: { owner: string; type: string }[] = [], synonyms: { owner: string; tableOwner: string; tableName: string }[] = []) =>
  async (name: string) => ({ name: name.toUpperCase(), objects, synonyms });
const noColumns = vi.fn();

it("ORA-00942：表在别的 schema 下找到时，给切 schema、加前缀、相似名三层修复", async () => {
  const fixes = await sqlQuickFixes("ORA-00942", "select * from po_orde", ["PO_ORDER"], noColumns,
    loc([{ owner: "OTHER", type: "TABLE" }]));
  expect(fixes).toEqual([
    { start: 0, end: 0, text: "", schema: "OTHER" },
    { start: 14, end: 21, text: "other.po_orde" },
    { start: 14, end: 21, text: "po_order" },
  ]);
});

it("ORA-00942：多个缺表都指向同一 schema 时只给一键切过去", async () => {
  const fixes = await sqlQuickFixes("ORA-00942", "select * from a join b on 1=1", [], noColumns,
    loc([{ owner: "S", type: "TABLE" }]));
  expect(fixes).toEqual([{ start: 0, end: 0, text: "", schema: "S" }]);
});

it("ORA-00942 反例：缺表指向不同 schema、或有一张哪都找不到，都不替用户选 schema", async () => {
  const byName: Record<string, { owner: string; type: string }[]> = {
    A: [{ owner: "S1", type: "TABLE" }], B: [{ owner: "S2", type: "TABLE" }],
  };
  const locate = async (name: string) => ({ name, objects: byName[name.toUpperCase()] ?? [], synonyms: [] });
  expect(await sqlQuickFixes("ORA-00942", "select * from a join b on 1=1", [], noColumns, locate)).toEqual([]);
  const partial = async (name: string) => ({ name, objects: name.toUpperCase() === "A" ? [{ owner: "S", type: "TABLE" }] : [], synonyms: [] });
  expect(await sqlQuickFixes("ORA-00942", "select * from a join b on 1=1", [], noColumns, partial)).toEqual([]);
});

it("ORA-00942：单表多个候选 owner 时给前缀修复但不给切 schema", async () => {
  const fixes = await sqlQuickFixes("ORA-00942", "select * from t", [], noColumns,
    loc([{ owner: "S1", type: "TABLE" }, { owner: "S2", type: "VIEW" }]));
  expect(fixes).toEqual([
    { start: 14, end: 15, text: "s1.t" },
    { start: 14, end: 15, text: "s2.t" },
  ]);
});

it("ORA-00942：私有同义词也是线索（登录账号有同义词、current_schema 切走了）", async () => {
  const fixes = await sqlQuickFixes("ORA-00942", "select * from t", [], noColumns,
    loc([], [{ owner: "LOGIN", tableOwner: "REAL", tableName: "T" }]));
  expect(fixes).toEqual([
    { start: 0, end: 0, text: "", schema: "LOGIN" },
    { start: 14, end: 15, text: "login.t" },
  ]);
});

it("ORA-00942：探查无结果时退回相似名；已限定 owner 的表不探查", async () => {
  expect(await sqlQuickFixes("ORA-00942", "select * from po_orde", ["PO_ORDER"], noColumns, loc()))
    .toEqual([{ start: 14, end: 21, text: "po_order" }]);
  const locate = vi.fn();
  expect(await sqlQuickFixes("ORA-00942", "select * from other.po_orde", ["PO_ORDER"], noColumns, locate)).toEqual([]);
  expect(locate).not.toHaveBeenCalled();
});
