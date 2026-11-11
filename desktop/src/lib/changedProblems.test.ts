import { describe, expect, it } from "vitest";
import { computeChanged, EMPTY_CHANGED } from "./changedLines";
import { problemsInChangedArea } from "./changedProblems";
import type { Problem } from "./compile";
import type { CodeDiag } from "./diagStore";

const path = "D:/work/src/A.java";
const other = "d:/WORK/src/B.java";
const snap = computeChanged("a\nb\nc\nd\n", "a\nB\nc\nd\n");
const p = (line: number, message: string, file = path): Problem => ({ line, message, file, severity: "error" });
const d = (line: number, message: string): CodeDiag => ({ line, message, path, severity: "error" } as CodeDiag);

/** 新签名：activePath 判「改动区」，scopePaths 是本轮文件范围（P1-7）。 */
describe("problemsInChangedArea", () => {
  it("本轮范围内的错误都收，改动区的排前面并打标记", () => {
    const r = problemsInChangedArea(path, [path], [p(2, "改坏了"), p(4, "旧错误")], [], snap);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ line: 2, message: "改坏了", source: "ecj", inChangedArea: true });
    expect(r[1]).toMatchObject({ line: 4, inChangedArea: false });
  });

  it("ecj 与 jdt.ls 同行同原文只留一条", () => {
    const r = problemsInChangedArea(path, [path], [p(2, "同一句")], [d(2, "同一句")], snap);
    expect(r).toHaveLength(1);
    expect(r[0].source).toBe("ecj");
  });

  it("不在本轮范围的文件排除；在范围内则收（大小写不敏感）", () => {
    expect(problemsInChangedArea(path, [path], [p(2, "x", other)], [], snap)).toEqual([]);
    const r = problemsInChangedArea(path, [path, other], [p(7, "调用点挂了", other)], [], snap);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: other, line: 7, inChangedArea: false });
  });

  it("P1-7 回归：AI 改方法签名导致别的文件报错，不再被过滤掉", () => {
    const r = problemsInChangedArea(path, [path, other], [p(2, "签名不匹配", other)], [], snap);
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe(other);
    expect(r[0].inChangedArea).toBe(false);
  });

  it("没有改动 / 超大文件降级时不再冒充改动区错误", () => {
    const a = problemsInChangedArea(path, [path], [p(2, "x")], [], EMPTY_CHANGED);
    expect(a).toHaveLength(1);
    expect(a[0].inChangedArea).toBe(false);
    const b = problemsInChangedArea(path, [path], [p(2, "x")], [], { ...snap, tooBig: true });
    expect(b).toHaveLength(1);
    expect(b[0].inChangedArea).toBe(false);
  });

  it("scope 为空时退化为只看当前文件", () => {
    const r = problemsInChangedArea(path, [], [p(2, "x"), p(3, "y", other)], [], snap);
    expect(r).toHaveLength(1);
    expect(r[0].line).toBe(2);
  });

  it("改动区优先，其次按路径与行号升序，warning 也收", () => {
    const s = computeChanged("a\nb\nc\n", "A\nB\nc\n");
    const warn: Problem = { line: 2, message: "警告", file: path, severity: "warning" };
    const r = problemsInChangedArea(path, [path], [warn, p(1, "错误")], [], s);
    expect(r.map((x) => x.line)).toEqual([1, 2]);
    expect(r[1].severity).toBe("warning");
  });
});
