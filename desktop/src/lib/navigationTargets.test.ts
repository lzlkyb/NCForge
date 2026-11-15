import { describe, expect, it } from "vitest";
import { filterNavigationTargets, navigationTargets, qualifiedTypeAt, validNavigationRange, typeSearchQueries } from "./navigationTargets";
const range = { start: { line: 4, character: 6 }, end: { line: 4, character: 11 } };
describe("accurate code navigation", () => {
  it("preserves distinct archives and overload positions while removing duplicate locations", () => {
    const uri = "nc-library://files/D%3A%2Fa%2Fshared.jar/nc/A.class?archive=1";
    const second = uri.replace("%2Fa%2F", "%2Fb%2F");
    const items = navigationTargets([{ uri, range }, { uri, range }, { targetUri: second, targetSelectionRange: range }, { uri, range: { ...range, start: { line: 10, character: 0 } , end: { line: 10, character: 4 } } }]);
    expect(items).toHaveLength(3);
    expect(items.map(item => item.source)).toContain("D:/b/shared.jar ! nc/A.class");
  });
  it("accepts JDT parent links and rejects malformed positions and unrelated protocols", () => {
    expect(navigationTargets([{ displayName: "IService.save", location: { uri: "jdt://contents/api.jar/nc/IService.class?=x", range } }])[0].label).toBe("IService.save");
    expect(navigationTargets([null, {}, { uri: "https://example.com", range }, { uri: "file:///D:/A.java", range: { start: { line: -1, character: 0 }, end: range.end } }])).toEqual([]);
    expect(validNavigationRange({ start: range.end, end: range.start })).toBe(false);
  });
  it("filters precise package/source/module scopes without combining same-name targets", () => {
    const targets = navigationTargets([{ uri: "file:///D:/src/A.java", range }, { uri: "jdt://contents/api.jar/nc/A.class?=x", range }]);
    targets[0].module = "sales";
    expect(filterNavigationTargets(targets, "A.java", "source", "sales")).toHaveLength(1);
    expect(filterNavigationTargets(targets, "api.jar", "source")).toHaveLength(0);
    expect(filterNavigationTargets(targets, "api.jar", "library")).toHaveLength(1);
  });
  it("reads a complete interface name at NC lookup and handles class literals and imports", () => {
    const text = "package demo;\nimport nc.itf.eyepriceguide.IEyepriceguideMaintain;\nNCLocator.getInstance().lookup(IEyepriceguideMaintain.class);";
    expect(qualifiedTypeAt(text, 3, 35)).toBe("nc.itf.eyepriceguide.IEyepriceguideMaintain");
    expect(qualifiedTypeAt("nc.ui.pp.m28.editor.card.afteredit.CardBodyAfterEditEventHandler", 1, 25)).toBe("nc.ui.pp.m28.editor.card.afteredit.CardBodyAfterEditEventHandler");
    expect(qualifiedTypeAt("value = 1;", 1, 2)).toBeNull();
  });
  it("does not copy object methods or commented imports and preserves nested types", () => {
    expect(qualifiedTypeAt("obj.method();", 1, 6)).toBeNull();
    expect(qualifiedTypeAt('package demo;\n// import wrong.Outer;\nimport real.Outer;\nOuter.Inner.class', 4, 8)).toBe("real.Outer.Inner");
    expect(qualifiedTypeAt('package demo; class Outer {}\nOuter.Inner.class', 2, 8)).toBe("demo.Outer.Inner");
    expect(qualifiedTypeAt('"nc.fake.Type"', 1, 8)).toBeNull();
    expect(qualifiedTypeAt('Outer.call();', 1, 9)).toBeNull();
  });
  it("keeps semantic field read/write classification including uncertain references", () => {
    const targets = navigationTargets(["read", "write", "readWrite", "unknown"].map((access, line) => ({ uri: "file:///D:/A.java", range: { start: { line, character: 1 }, end: { line, character: 3 } }, access })));
    expect(filterNavigationTargets(targets, "", "all", "all", "read").map(target => target.access)).toEqual(["read", "readWrite"]);
    expect(filterNavigationTargets(targets, "", "all", "all", "write")).toHaveLength(2);
    expect(filterNavigationTargets(targets, "", "all", "all", "unknown")).toHaveLength(1);
  });
  it("searches nested source and binary names without losing the package", () => {
    expect(typeSearchQueries("demo.Outer.Inner")).toEqual(["demo.Outer.Inner", "demo.Outer$Inner"]);
    expect(typeSearchQueries("demo.Outer")).toEqual(["demo.Outer"]);
  });
});
