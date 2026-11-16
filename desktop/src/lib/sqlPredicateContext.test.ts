import { expect, it } from "vitest";
import { analyzeSql } from "./sqlScope";
import { completionContext } from "./sqlCompletionContext";
import { sqlPredicateContext } from "./sqlPredicateContext";

function at(sql: string) {
  const offset = sql.indexOf("|"), analysis = analyzeSql(sql.replace("|", ""), "plsql");
  return sqlPredicateContext(analysis, offset, completionContext(analysis, offset, "plsql").clause);
}
it("recognizes new WHERE/AND/OR/ON operands and boolean parentheses", () => {
  for (const tail of ["WHERE |", "WHERE 名称|", "WHERE a.|", "WHERE a.na|", "WHERE NOT (a.|)", "WHERE a.id=1 AND |", "WHERE (a.id=1 OR |)", "LEFT JOIN lines b ON b.|", "WHERE a.id BETWEEN 1 AND 2 AND |"])
    expect(at("SELECT * FROM orders a " + tail)?.kind, tail).toBe("field");
});
it("only expands parentheses that contain a boolean predicate, and tracks direct NOT", () => {
  for (const tail of ["WHERE (a.|) = 1", "WHERE (a.|) + 1 > 0", "WHERE ((a.na|me)) IS NULL"])
    expect(at("SELECT * FROM orders a " + tail)).toBeUndefined();
  expect(at("SELECT * FROM orders a WHERE (a.|) AND a.id=1")).toMatchObject({ kind: "field", negated: false });
  expect(at("SELECT * FROM orders a WHERE NOT a.created|")).toMatchObject({ kind: "field", negated: true });
  // 🔴 显式分组后 negated 归零是**有意设计**（2026-11-16 复核确认，别改成继承）：
  // `NOT (a.created)` 里插入的复合范围自带括号、整体落在 NOT 内，语义正确应当放行；
  // 不分组时插入才会破坏 NOT 作用域。另见 sqlProviders.test.ts:417 / :507。
  expect(at("SELECT * FROM orders a WHERE NOT (a.created|)")).toMatchObject({ kind: "field", negated: false });
});
it("显式分组重置 negated，分组内的直接 NOT 仍然算取反", () => {
  // 多层分组同样重置（用户已经自己划好了作用域）
  expect(at("SELECT * FROM orders a WHERE NOT ((a.created|))")).toMatchObject({ kind: "field", negated: false });
  expect(at("SELECT * FROM orders a WHERE NOT (a.id=1 AND a.created|)")).toMatchObject({ kind: "field", negated: false });
  expect(at("SELECT * FROM orders a WHERE (a.created|)")).toMatchObject({ kind: "field", negated: false });
  // 分组**内部**的直接 NOT 照旧取反
  expect(at("SELECT * FROM orders a WHERE NOT (NOT a.created|)")).toMatchObject({ kind: "field", negated: true });
});
it("does not extend fields in expressions, values, functions, CASE, or existing predicates", () => {
  for (const sql of ["SELECT a.| FROM orders a", "SELECT * FROM orders a WHERE a.id = a.|", "SELECT * FROM orders a WHERE a.id BETWEEN 1 AND a.|",
    "SELECT * FROM orders a WHERE COALESCE(a.|, 0)=1", "SELECT * FROM orders a WHERE a.id IN (a.|)", "SELECT * FROM orders a WHERE a.id + a.| > 0",
    "SELECT * FROM orders a WHERE CASE WHEN a.| THEN 1 END=1", "SELECT * FROM orders a WHERE a.na|me = 'x'", "SELECT * FROM orders a WHERE a.na|me LIKE 'x'",
    "SELECT * FROM orders a WHERE 'a.|'", "SELECT * FROM orders a -- WHERE a.|", "SELECT * FROM orders a WHERE EXISTS (SELECT | FROM lines)"])
    expect(at(sql), sql).toBeUndefined();
});
it("recognizes a field followed by an operator prefix without consuming the field", () => {
  const sql = "SELECT * FROM orders a WHERE a.name LI|";
  expect(at(sql)).toMatchObject({ kind: "operator", field: "name", fieldRef: "name", source: { table: "orders", alias: "a" }, start: sql.indexOf("LI|"), end: sql.indexOf("|") });
  expect(at("SELECT * FROM orders a WHERE a.name |")?.kind).toBe("operator");
  expect(at("SELECT * FROM orders a WHERE a.name = | ")).toBeUndefined();
  expect(at("SELECT * FROM orders a WHERE a.name IN (|)")).toBeUndefined();
});
it("keeps nested query sources and quoted identities, rejects ambiguous and future aliases", () => {
  expect(at('SELECT * FROM orders a WHERE EXISTS (SELECT 1 FROM lines a WHERE a."Name" |)')).toMatchObject({ source: { table: "lines" }, field: "Name", fieldRef: '"Name"' });
  expect(at("SELECT * FROM orders a JOIN lines b ON a.id=b.id WHERE name |")).toBeUndefined();
  expect(at("SELECT * FROM orders a JOIN lines b ON c.id | JOIN tax c ON 1=1")).toBeUndefined();
});
