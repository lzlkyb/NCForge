import { expect, it } from "vitest";
import { bindQuery, canParameterizeQuery, parameterizeLiteral, queryParameters } from "./sqlQueryParameters";

it("replaces a selected literal and binds repeated names in occurrence order", () => {
  const sql = "select * from po_order where vbillcode = 'PO-01'";
  const start = sql.indexOf("'PO-01'");
  const draft = parameterizeLiteral(sql, start, sql.length, "bill_no")!;
  expect(draft).toBe("select * from po_order where vbillcode = :bill_no");
  const repeated = draft + " or code = :BILL_NO and label = q'[:ignored]' -- :ignored";
  expect(queryParameters(repeated)).toEqual(["bill_no"]);
  expect(bindQuery(repeated, new Map([["bill_no", "O'Brien"]]))).toEqual({
    sql: "select * from po_order where vbillcode = :1 or code = :2 and label = q'[:ignored]' -- :ignored",
    params: ["O'Brien", "O'Brien"],
  });
  expect(parameterizeLiteral(sql, start + 1, sql.length - 1, "bill_no")).toBeNull();
});

it("keeps scripts, writes and mixed bind formats out of the query form", () => {
  for (const sql of ["select :x from dual; delete from t", "update t set a=:x", "select :x, ? from dual", "select :x, :1 from dual"]) {
    expect(canParameterizeQuery(sql)).toBe(false);
  }
  expect(() => bindQuery("select :x from dual", new Map())).toThrow();
});
