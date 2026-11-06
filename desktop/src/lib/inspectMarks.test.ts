import { describe, expect, it } from "vitest";
import { buildInspectMarks, inspectMarkOf } from "./inspectMarks";

describe("buildInspectMarks", () => {
  it("按文件与每一级祖先目录聚合，三档分开计数", () => {
    const diags = [
      { path: "C:\\w\\GL\\src\\public\\p\\A.java", line: 1, column: 1, severity: "error" as const, message: "e" },
      { path: "C:\\w\\GL\\src\\public\\p\\A.java", line: 2, column: 1, severity: "warning" as const, message: "w" },
      { path: "C:\\w\\GL\\src\\public\\p\\B.java", line: 1, column: 1, severity: "info" as const, message: "i" },
    ];
    const marks = buildInspectMarks(diags, "C:\\w");
    expect(inspectMarkOf(marks, "c:/w/gl/src/public/p")).toEqual({
      errors: 1,
      warnings: 1,
      info: 1,
      total: 3,
    });
    expect(inspectMarkOf(marks, "C:\\w\\GL")).toEqual({
      errors: 1,
      warnings: 1,
      info: 1,
      total: 3,
    });
    expect(inspectMarkOf(marks, "C:\\w\\GL\\src\\public\\p\\A.java")).toEqual({
      errors: 1,
      warnings: 1,
      info: 0,
      total: 2,
    });
  });

  it("根外路径（含同前缀兄弟目录）不计入", () => {
    const marks = buildInspectMarks(
      [
        { path: "C:\\w-备份\\A.java", line: 1, column: 1, severity: "error" as const, message: "x" },
        { path: "D:\\other\\A.java", line: 1, column: 1, severity: "error" as const, message: "x" },
      ],
      "C:\\w",
    );
    expect(marks.size).toBe(0);
  });

  it("空根返回空表", () => {
    expect(buildInspectMarks([], "").size).toBe(0);
  });
});
