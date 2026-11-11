import { expect, it } from "vitest";
import { analyzeSql } from "./sqlScope";
import { completionContext } from "./sqlCompletionContext";
const at = (sql: string, dialect: "plsql" | "postgresql" = "plsql") => { const offset = sql.indexOf("|"); return completionContext(analyzeSql(sql.replace("|", ""), dialect), offset, dialect); };
it("preserves owner and quoted identity without changing basename callers", () => {
  const source = analyzeSql('select * from "Other"."Table" t').scopes[0].sources[0];
  expect(source).toMatchObject({ table: "Table", tableRef: '"Other"."Table"', schema: "Other", quoted: true });
});
it("distinguishes schema completion from aliases", () => {
  expect(at("select * from app.| ").kind).toBe("schema");
  expect(at("select m.| from app.material m").kind).toBe("column");
});
it("isolates clauses and lowers fields already assigned in SET", () => {
  expect(at("update a set code=1, | where id=2")).toMatchObject({ clause: "set", assigned: ["code"] });
  expect(at("select * from a where exists(select | from b)").clause).toBe("select");
  expect(at("select * from a where id in (select id from b) and |").clause).toBe("where");
});
it("only suggests projection aliases where the dialect allows them", () => {
  expect(at("select id as item from a order by |").projections).toContain("item");
  expect(at("select id as item from a group by |").projections).toEqual([]);
  expect(at("select id as item from a group by |", "postgresql").projections).toContain("item");
});
it("literal suggestions are scoped to field comparisons, never ordinary strings", () => {
  expect(at("select * from a m where m.status = '|")).toMatchObject({ kind: "value", field: "status", valueSource: { table: "a" } });
  expect(at("select 'from a |'").kind).toBe("none");
  expect(at("select * from a -- where status=|").kind).toBe("none");
});

it("does not consume whitespace after a value insertion", () => {
  const sql = "select * from a where status = |  and id = 1";
  expect(at(sql)).toMatchObject({ kind: "value", valueStart: sql.indexOf("|"), valueEnd: sql.indexOf("|") });
});
it("does not treat quoted clause names as SQL clauses", () => {
  expect(at('select "where", | from a').clause).toBe("select");
  expect(at('select * from a order by "where", |').clause).toBe("order");
});
