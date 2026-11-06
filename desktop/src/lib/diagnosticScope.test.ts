import { describe, expect, it } from "vitest";
import { scopeProblems, sourceContext } from "./diagnosticScope";
import type { UnifiedProblem } from "./problemList";
const problem = (path: string): UnifiedProblem => ({ path, line: 1, severity: "error", source: "compile", message: "error" });
const problems = [problem("D:\\Root\\gl\\src\\A.java"), problem("d:/root/gl/src/B.java"), problem("D:/Root/gl2/src/C.java"), problem("D:/Root-other/gl/src/A.java")];
describe("diagnostic scope", () => {
  it("matches files case-insensitively across slash styles", () => expect(scopeProblems(problems, "file", "D:/Root", "d:/root/GL/src/a.java")).toEqual([problems[0]]));
  it("matches module boundaries and excludes similarly prefixed roots", () => expect(scopeProblems(problems, "module", "D:/Root", "d:/root/gl/src/A.java")).toEqual(problems.slice(0, 2)));
  it("requires a real current module, while project scope preserves all source diagnostics", () => {
    expect(scopeProblems(problems, "module", "D:/Root", "jdt://A.java")).toEqual([]);
    expect(scopeProblems(problems, "file", null, null)).toEqual([]);
    expect(scopeProblems(problems, "project", null, null)).toBe(problems);
  });
});
describe("bounded source context", () => {
  it("clips beginning and end without changing displayed line numbers", () => {
    const text = Array.from({ length: 20 }, (_, index) => String(index + 1)).join("\n");
    expect(sourceContext(text, 1).map(row => row.line)).toEqual([1, 2, 3, 4]);
    expect(sourceContext(text, 200).map(row => row.line)).toEqual([17, 18, 19, 20]);
    expect(sourceContext(text, 10).filter(row => row.current)).toEqual([{ line: 10, text: "10", current: true }]);
  });
  it("bounds generated lines and accepts empty/CRLF files", () => {
    expect(sourceContext("a\r\n" + "x".repeat(2000), 2)[1].text).toHaveLength(1001);
    expect(sourceContext("", 0)).toEqual([{ line: 1, text: "", current: true }]);
  });
});
