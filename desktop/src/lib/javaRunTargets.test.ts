import { describe, expect, it } from "vitest";
import { javaRunDeclarations, javaTestLensTargets } from "./javaRunTargets";

const targets = (source: string) => [...javaTestLensTargets(source).values()];
const keyAt = (source: string, name: string) => {
  const offset = source.indexOf(name), before = source.slice(0, offset);
  return `${before.split("\n").length}:${offset - source.lastIndexOf("\n", offset)}`;
};
describe("exact Java test declarations", () => {
  it("does not transfer a neighboring test annotation to an unannotated method", () => {
    expect(targets("package demo; class A { @Test void first() {} void helper() {} @Test void last() {} }"))
      .toEqual(["demo.A#first", "demo.A#last"]);
  });
  it("distinguishes multiple tests on the same source line by name column", () => {
    const source = "class A { @Test void first() {} @Test void second() {} }";
    const lenses = javaTestLensTargets(source);
    expect(lenses.get(keyAt(source, "first"))).toBe("A#first");
    expect(lenses.get(keyAt(source, "second"))).toBe("A#second");
    expect(lenses.size).toBe(2);
  });
  it("uses enclosing type parent chains for nested binary names and other top-level classes", () => {
    expect(targets("package demo; class A { class B { class C { @Test void deep() {} } @Test void inner() {} } @Test void outer() {} } class Other { @Test void own() {} }"))
      .toEqual(["demo.A$B$C#deep", "demo.A$B#inner", "demo.A#outer", "demo.Other#own"]);
  });
  it("ignores fake annotations inside literals and comments", () => {
    expect(targets('class A { String fake = "@Test void no() {}"; /* @Test */ void helper() {} // @Test\n void other() {} @org.junit.Test void yes() {} }'))
      .toEqual(["A#yes"]);
  });
  it("keeps array-valued annotation arguments in the current method header", () => {
    expect(targets('class A { @Other(value={";", "}"}) @org.junit.jupiter.api.ParameterizedTest(name="{0}") void values() {} @RepeatedTest(2) void twice() {} }'))
      .toEqual(["A#values", "A#twice"]);
  });
  it("preserves exact columns through multiline annotations and CRLF", () => {
    const source = "package demo;\r\nclass A {\r\n  @Test\r\n  public void\r\n      sample() {}\r\n}";
    expect(javaTestLensTargets(source).get("5:7")).toBe("demo.A#sample");
    const method = javaRunDeclarations(source).find(row => row.kind === "method")!;
    expect(source.slice(method.start, method.end)).toContain("@Test\r\n  public void\r\n      sample() {}");
  });
});
