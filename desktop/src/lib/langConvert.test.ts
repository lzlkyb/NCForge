import { describe, expect, it } from "vitest";
import {
  completionKindName,
  contentsToMarkdown,
  isStubSource,
  jdtDisplayName,
  severityName,
  toLspPosition,
  toMonacoRange,
  toTargets,
  uriToPath,
} from "./langConvert";

describe("langConvert", () => {
  it("行列两头换算互为逆运算", () => {
    expect(toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 2, character: 5 } })).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 6,
    });
    expect(toLspPosition(10, 4)).toEqual({ line: 9, character: 3 });
  });

  it("file URI 解成 Windows 路径，支持中文、空格与 %3A", () => {
    expect(uriToPath("file:///C:/work/aier/newar/gl/A.java")).toBe("C:\\work\\aier\\newar\\gl\\A.java");
    expect(uriToPath("file:///c%3A/work/%E6%80%BB%E8%B4%A6%20gl/A.java")).toBe("c:\\work\\总账 gl\\A.java");
    expect(uriToPath("jdt://contents/x.jar/a/B.class")).toBeNull();
    expect(uriToPath("file:///C:/bad%ZZ")).toBeNull();
  });

  it("jdt 地址取类名显示为 .java，并认出反编译桩", () => {
    expect(jdtDisplayName("jdt://contents/pub.jar/nc.bs.dao/BaseDAO.class?=proj/x%5C.jar")).toBe("BaseDAO.java");
    expect(isStubSource("// Failed to get sources. Instead, stub sources have been generated")).toBe(true);
    expect(isStubSource("public class BaseDAO {}")).toBe(false);
  });

  it("补全种类与诊断级别映射，越界值不崩", () => {
    expect(completionKindName(2)).toBe("Method");
    expect(completionKindName(7)).toBe("Class");
    expect(completionKindName(undefined)).toBe("Text");
    expect(completionKindName(999)).toBe("Text");
    expect(severityName(1)).toBe("Error");
    expect(severityName(2)).toBe("Warning");
    expect(severityName(undefined)).toBe("Error");
  });

  it("hover 内容统一成 Markdown 段落", () => {
    expect(contentsToMarkdown({ kind: "markdown", value: "**a**" })).toEqual(["**a**"]);
    expect(contentsToMarkdown([{ language: "java", value: "int x;" }, "说明"])).toEqual([
      "```java\nint x;\n```",
      "说明",
    ]);
    expect(contentsToMarkdown(null)).toEqual([]);
    expect(contentsToMarkdown({ kind: "plaintext", value: "" })).toEqual([]);
  });

  it("跳转目标兼容 Location 与 LocationLink", () => {
    const r = { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } };
    expect(toTargets({ uri: "file:///a", range: r })).toEqual([{ uri: "file:///a", range: r }]);
    expect(toTargets([{ targetUri: "jdt://x", targetRange: r, targetSelectionRange: r }])).toEqual([
      { uri: "jdt://x", range: r },
    ]);
    expect(toTargets(null)).toEqual([]);
    expect(toTargets([{ foo: 1 }])).toEqual([]);
  });
});
