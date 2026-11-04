import { describe, expect, it } from "vitest";
import { isAutoCompileTarget, mergeFileResult } from "./autoCompile";
import type { CompileResult } from "./compile";

const result = (over: Partial<CompileResult> = {}): CompileResult => ({
  ok: true,
  durationMs: 1,
  sourceCount: 1,
  errorCount: 0,
  warningCount: 0,
  problems: [],
  jarCount: 3,
  rounds: 1,
  outDir: "C:/work/aier/newar/gl/classes",
  diagnostics: [],
  ...over,
});

describe("isAutoCompileTarget", () => {
  it("只认工作区内、磁盘上的 .java", () => {
    expect(isAutoCompileTarget("C:\\work\\aier\\newar\\gl\\src\\A.java", "C:\\work\\aier\\newar")).toBe(true);
    expect(isAutoCompileTarget("C:\\work\\aier\\newar\\gl\\p.xml", "C:\\work\\aier\\newar")).toBe(false);
    expect(isAutoCompileTarget("C:\\work\\aier\\newar\\gl\\jdt://x/A.java", "C:\\work\\aier\\newar")).toBe(false);
  });

  it("分隔符 / 大小写 / 根目录尾斜杠都不影响判断", () => {
    const root = "C:/work/aier/newar/";
    expect(isAutoCompileTarget("c:\\Work\\AIER\\newar\\aim\\src\\B.JAVA", root)).toBe(true);
  });

  it("共享前缀的兄弟目录不算工作区内", () => {
    // `newar-备份` 以 `newar` 开头，但不在工作区里
    expect(isAutoCompileTarget("C:\\work\\aier\\newar-备份\\gl\\A.java", "C:\\work\\aier\\newar")).toBe(false);
  });

  it("关联工程（工作区之外）不编：它们有自己的 .classpath，切过去才编得了", () => {
    expect(isAutoCompileTarget("D:\\other\\bill\\src\\B.java", "C:\\work\\aier\\newar")).toBe(false);
  });

  it("root 为空时不编", () => {
    expect(isAutoCompileTarget("C:\\work\\aier\\newar\\gl\\A.java", null)).toBe(false);
  });
});

describe("mergeFileResult", () => {
  const err = (file: string, message: string) => ({ severity: "error" as const, file, line: 1, message });

  it("只替换这个文件的问题，别的文件的历史问题要留着", () => {
    const prev = result({
      ok: false,
      errorCount: 3,
      problems: [err("C:/w/A.java", "a1"), err("C:/w/A.java", "a2"), err("C:/w/B.java", "b1")],
    });
    // A 这次编过了
    const next = result({ problems: [] });
    const merged = mergeFileResult(prev, next, ["C:\\w\\a.java"]);
    expect(merged.problems.map((p) => p.message)).toEqual(["b1"]);
    expect(merged.errorCount).toBe(1);
    expect(merged.ok).toBe(false);
  });

  it("新错误替换旧错误，不叠加", () => {
    const prev = result({ problems: [err("C:/w/A.java", "旧的")] });
    const next = result({ problems: [err("C:/w/A.java", "新的")] });
    const merged = mergeFileResult(prev, next, ["C:/w/A.java"]);
    expect(merged.problems.map((p) => p.message)).toEqual(["新的"]);
    expect(merged.errorCount).toBe(1);
    expect(merged.ok).toBe(false);
  });

  it("全清干净时 ok 变回 true", () => {
    const prev = result({ ok: false, errorCount: 1, problems: [err("C:/w/A.java", "x")] });
    const merged = mergeFileResult(prev, result(), ["C:/w/A.java"]);
    expect(merged.problems).toEqual([]);
    expect(merged.ok).toBe(true);
    expect(merged.warningCount).toBe(0);
  });

  it("没有上一轮结果时直接采用本次", () => {
    const next = result({ problems: [err("C:/w/A.java", "x")] });
    expect(mergeFileResult(null, next, ["C:/w/A.java"])).toBe(next);
  });

  it("诊断按身份并集去重：D4 那几条不能因为一次单文件编译就消失", () => {
    const d = { kind: "uncompiled" as const, project: "gl", message: "有源码没产物", file: "C:/w/X.java" };
    const prev = result({ diagnostics: [d] });
    const next = result({ diagnostics: [{ ...d, message: "措辞变了" }] });
    const merged = mergeFileResult(prev, next, ["C:/w/A.java"]);
    expect(merged.diagnostics).toHaveLength(1);
    expect(merged.diagnostics[0].message).toBe("措辞变了");
  });

  // 一批可能跨模块（连续保存了几个目录下的文件），所以替换是按集合算的
  it("一批里只替换这批文件的问题，批次外的历史问题留着", () => {
    const prev = result({
      ok: false,
      errorCount: 3,
      problems: [
        err("C:/w/A.java", "a"),
        err("C:/w/B.java", "b"),
        err("C:/w/C.java", "c"),
      ],
    });
    const next = result({ problems: [err("C:/w/B.java", "b2")] });
    const merged = mergeFileResult(prev, next, ["C:/w/A.java", "C:/w/B.java"]);
    expect(merged.problems.map((p) => p.message).sort()).toEqual(["b2", "c"]);
    expect(merged.errorCount).toBe(2);
  });
});
