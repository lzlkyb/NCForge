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
