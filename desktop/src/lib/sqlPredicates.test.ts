import { expect, it } from "vitest";
import { sqlPredicates } from "./sqlPredicates";

it("puts text inside quotes and numeric input outside, without default values or parameters", () => {
  expect(sqlPredicates("a.name", "VARCHAR2(50)", "plsql", true)[0].insertText).toBe("a.name = '$0'");
  expect(sqlPredicates("b.nnum", "NUMBER(20,8)", "plsql", true)[0].insertText).toBe("b.nnum = $0");
  expect(sqlPredicates("a.dbilldate", "CHAR(19)", "plsql", true)[0].insertText).toBe("a.dbilldate = '$0'");
});
it("offers appropriate operators and editable IN/BETWEEN operands", () => {
  const text = sqlPredicates("a.code", "VARCHAR2(50)", "plsql", true);
  expect(text.find(p => p.operator === "LIKE")?.insertText).toBe("a.code LIKE '%$0%'");
  expect(text.find(p => p.operator === "IN")?.insertText).toBe("a.code IN ('${1}', '${2}')$0");
  expect(text.find(p => p.operator === "IS NULL")?.insertText).toBe("a.code IS NULL$0");
  const numeric = sqlPredicates("b.qty", "NUMBER", "plsql", false);
  expect(numeric.find(p => p.operator === "BETWEEN")?.insertText).toBe("b.qty between ${1} and ${2}$0");
  expect(numeric.some(p => p.operator === "LIKE")).toBe(false);
});
it("uses real temporal types and half-open date ranges", () => {
  expect(sqlPredicates("a.created", "DATE", "plsql", true)[0].insertText).toBe("a.created = DATE '$0'");
  expect(sqlPredicates("a.created", "TIMESTAMP(6)", "plsql", true)[0].insertText).toBe("a.created = TIMESTAMP '$0'");
  expect(sqlPredicates("a.created", "DATE", "plsql", true).find(p => p.operator === "RANGE")?.insertText).toBe("a.created >= DATE '${1}' AND a.created < DATE '${2}'$0");
  expect(sqlPredicates("a.created", "datetime2", "tsql", true)[0].insertText).toBe("a.created = CAST('$0' AS datetime2)");
  expect(sqlPredicates("a.created", "datetime", "mysql", true)[0].insertText).toBe("a.created = CAST('$0' AS DATETIME)");
  expect(sqlPredicates("a.created", "timestamp without time zone", "postgresql", true)[0].insertText).toBe("a.created = TIMESTAMP '$0'");
  expect(sqlPredicates("a.created", "timestamp with time zone", "postgresql", true)[0].insertText).toBe("a.created = TIMESTAMP WITH TIME ZONE '$0'");
  expect(sqlPredicates("a.version", "TIMESTAMP(8)", "tsql", true).map(p => p.operator)).toEqual(["IS NULL", "IS NOT NULL"]);
});
it("escapes identifiers as literals and does not invent comparisons for LOB/unknown types", () => {
  expect(sqlPredicates('"a$0"."name}"', "VARCHAR2", "plsql", true)[0].insertText).toBe('"a\\$0"."name\\}" = \'$0\'');
  for (const type of ["BLOB", "CLOB", "", "custom_type"]) expect(sqlPredicates("a.data", type, "plsql", true).map(p => p.operator)).toEqual(["IS NULL", "IS NOT NULL"]);
});
