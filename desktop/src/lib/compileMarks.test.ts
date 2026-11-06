import { describe, expect, it } from "vitest";
import { buildCompileMarks, markOf } from "./compileMarks";
import type { Problem } from "./compile";

const err = (file: string, message = "x"): Problem => ({ severity: "error", file, line: 1, message });
const warn = (file: string, message = "w"): Problem => ({ severity: "warning", file, line: 1, message });

describe("buildCompileMarks", () => {
  it("文件与每一层父目录都累计，模块/包行能先看到错", () => {
    const marks = buildCompileMarks([err("C:\\w\\gl\\src\\public\\p\\A.java"), err("C:\\w\\gl\\src\\public\\p\\B.java")], "C:\\w");
    expect(markOf(marks, "C:\\w\\gl\\src\\public\\p\\A.java")).toEqual({ errors: 1, warnings: 0 });
    expect(markOf(marks, "c:/W/GL/src/public/p")).toEqual({ errors: 2, warnings: 0 });
    expect(markOf(marks, "C:/w/gl")).toEqual({ errors: 2, warnings: 0 });
    expect(markOf(marks, "C:/w")).toEqual({ errors: 2, warnings: 0 });
  });

  it("错误与警告分开计数；只有警告时目录标记也是警告", () => {
    const marks = buildCompileMarks([err("C:/w/gl/A.java"), warn("C:/w/gl/A.java"), warn("C:/w/gl/B.java")], "C:/w");
    expect(markOf(marks, "C:/w/gl/A.java")).toEqual({ errors: 1, warnings: 1 });
    expect(markOf(marks, "C:/w/gl")).toEqual({ errors: 1, warnings: 2 });
    const onlyWarn = buildCompileMarks([warn("C:/w/gl/A.java")], "C:/w");
    expect(markOf(onlyWarn, "C:/w/gl")).toEqual({ errors: 0, warnings: 1 });
  });

  it("关联工程 / 工作区外的前缀相同目录不算：不能把别的工程的错挂到当前树", () => {
    const marks = buildCompileMarks([err("C:/w-备份/gl/A.java"), err("D:/other/gl/B.java")], "C:/w");
    expect(markOf(marks, "C:/w-备份/gl")).toBeUndefined();
    expect(markOf(marks, "D:/other/gl")).toBeUndefined();
    expect(markOf(marks, "C:/w")).toBeUndefined();
  });

  it("root 为空或没有问题时不产生标记", () => {
    expect(buildCompileMarks([err("C:/w/gl/A.java")], "").size).toBe(0);
    expect(buildCompileMarks([], "C:/w").size).toBe(0);
  });
});
