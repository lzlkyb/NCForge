import { expect, it } from "vitest";
import { javaTreeMembers } from "./javaTreeMembers";

it("resolves top-level declarations, overloads, enum constants and fields to their source positions", () => {
  const text = [
    "package example;",
    "// class Fake {}",
    '@Metadata(key = "class Wrong {}")',
    "public class Service {",
    "  private final int limit = defaultLimit();",
    "  Service() {}",
    "  void Service() {}",
    "  void run(int id) { int local = 0; }",
    "  void run(String id) {}",
    "  interface Nested { void execute(); }",
    "}",
    "enum Mode { A(1), B(2); private final int id = 0; Mode(int n) {} }",
    "@interface Marker { String value(); }",
  ].join("\n");
  const rows = javaTreeMembers("C:\\Service.java", text);
  expect(rows.map(row => [row.name, row.kind, row.line])).toEqual([
    ["Service", 5, 4], ["limit", 8, 5], ["Service()", 9, 6], ["Service()", 6, 7],
    ["run(int id)", 6, 8], ["run(String id)", 6, 9], ["Nested", 11, 10], ["execute()", 6, 10],
    ["Mode", 10, 12], ["A", 22, 12], ["B", 22, 12], ["id", 8, 12], ["Mode(int n)", 9, 12],
    ["Marker", 101, 13], ["value()", 6, 13],
  ]);
  expect(rows[1].parent).toBe(rows[0].id);
  expect(rows[7].parent).toBe(rows[6].id);
  expect(rows[4].column).toBe(8);
});
