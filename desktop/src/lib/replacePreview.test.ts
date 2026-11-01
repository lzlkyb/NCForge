import { describe, expect, it } from "vitest";
import { previewReplacedLine, replacePlan } from "./replacePreview";
import type { SearchHit } from "./search";

const hit = (path: string, line = 1): SearchHit => ({ path, line, text: "", ranges: [] });

describe("previewReplacedLine", () => {
  it("单处命中按区间替换", () => {
    expect(previewReplacedLine("void save() {}", [{ start: 5, end: 9 }], "persist")).toBe(
      "void persist() {}",
    );
  });

  it("一行多处全部替换", () => {
    const text = "save(); save();";
    expect(previewReplacedLine(text, [{ start: 0, end: 4 }, { start: 8, end: 12 }], "keep")).toBe(
      "keep(); keep();",
    );
  });

  it("替换为空串 = 删除文本", () => {
    // 区间 [4,8) 覆盖 "tmp "（含尾随空格），删掉后是 "int = 1;"
    expect(previewReplacedLine("int tmp = 1;", [{ start: 4, end: 8 }], "")).toBe("int = 1;");
  });

  it("区间超出文本长度时夹住，不抛错", () => {
    expect(previewReplacedLine("abc", [{ start: 2, end: 99 }], "XY")).toBe("abXY");
  });

  it("没有命中时原样返回", () => {
    expect(previewReplacedLine("abc", [], "X")).toBe("abc");
  });
});

describe("replacePlan", () => {
  it("按文件分组计数，保留搜索顺序", () => {
    const plan = replacePlan([hit("A.java"), hit("B.java"), hit("A.java")]);
    expect(plan.files).toBe(2);
    expect(plan.hits).toBe(3);
    expect(plan.top).toEqual([
      { path: "A.java", count: 2 },
      { path: "B.java", count: 1 },
    ]);
    expect(plan.rest).toBe(0);
  });

  it("超过 maxTop 的文件进 rest", () => {
    const hits = ["a", "b", "c", "d"].map((p) => hit(p));
    const plan = replacePlan(hits, 2);
    expect(plan.top.map((f) => f.path)).toEqual(["a", "b"]);
    expect(plan.rest).toBe(2);
  });

  it("空结果全为 0", () => {
    expect(replacePlan([])).toEqual({ files: 0, hits: 0, top: [], rest: 0 });
  });
});
