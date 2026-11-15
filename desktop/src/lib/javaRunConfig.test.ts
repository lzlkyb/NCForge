import { describe, expect, it } from "vitest";
import { sourceRunTarget, failedRunTargets, inputLines } from "./javaRunConfig";

describe("Java run target selection", () => {
  const source = "package nc.demo;\npublic class PriceTest {\n  public void testPrice() {\n    String text = \"void fake() {\";\n    if (true) { System.out.println(text); }\n  }\n  // between methods\n  public void testSecond() {\n    int value = 1;\n  }\n}\n";
  it("uses the declared package and class", () => expect(sourceRunTarget(source, 4)).toBe("nc.demo.PriceTest"));
  it("selects the containing method and ignores literal braces", () => {
    expect(sourceRunTarget(source, 4, true)).toBe("nc.demo.PriceTest#testPrice");
    expect(sourceRunTarget(source, 9, true)).toBe("nc.demo.PriceTest#testSecond");
    expect(sourceRunTarget(source, 7, true)).toBeNull();
  });
  it("preserves complete literal program arguments", () => expect(inputLines("two words\n--name=a;b\r\n\n")).toEqual(["two words", "--name=a;b"]));
  it("selects a complete single-line test declaration including its closing brace", () => {
    expect(sourceRunTarget("package demo;\r\npublic class Test {\r\n public void testOne() {}\r\n}", 3, true)).toBe("demo.Test#testOne");
  });
  it("selects same-line methods using the precise cursor column", () => {
    const text = "package demo; class A { void first() {} void second() {} }";
    expect(sourceRunTarget(text, 1, true, text.indexOf("first") + 1)).toBe("demo.A#first");
    expect(sourceRunTarget(text, 1, true, text.indexOf("second") + 1)).toBe("demo.A#second");
    expect(sourceRunTarget(text, 1, true, text.indexOf("{}") + 3)).toBeNull();
    expect(sourceRunTarget(text, 1, true, text.length)).toBeNull();
  });
  it("selects nested binary classes and methods independently from other top-level types", () => {
    const text = "package demo; class A { class B { void inner() {} } void outer() {} } class Other { void own() {} }";
    expect(sourceRunTarget(text, 1, false, text.indexOf("inner") + 1)).toBe("demo.A$B");
    expect(sourceRunTarget(text, 1, true, text.indexOf("inner") + 1)).toBe("demo.A$B#inner");
    expect(sourceRunTarget(text, 1, false, text.indexOf("own") + 1)).toBe("demo.Other");
    expect(sourceRunTarget(text, 1, true, text.indexOf("own") + 1)).toBe("demo.Other#own");
  });
  it("deduplicates failures and falls back to class selection for dynamic display names", () => expect(failedRunTargets([
    { className: "a.Test", method: "testPrice" }, { className: "a.Test", method: "testPrice" }, { className: "b.Test", method: "[1] value" },
  ])).toEqual(["a.Test#testPrice", "b.Test"]));
});
