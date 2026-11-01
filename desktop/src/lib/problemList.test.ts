import { describe, expect, it } from "vitest";
import { countErrors, mergeProblems, nextProblem } from "./problemList";
import type { CodeDiag } from "./diagStore";
import type { Problem } from "./compile";

const cp = (file: string, line: number, message = "x"): Problem => ({ severity: "error", file, line, message });
const cd = (
  path: string,
  line: number,
  message = "y",
  severity: CodeDiag["severity"] = "error",
): CodeDiag => ({
  path,
  line,
  column: 1,
  severity,
  message,
});

describe("mergeProblems", () => {
  it("两份合并后按路径和行号排序", () => {
    const out = mergeProblems([cp("C:\\w\\B.java", 10)], [cd("C:\\w\\A.java", 3)]);
    expect(out.map((p) => [p.path, p.line, p.source])).toEqual([
      ["C:\\w\\A.java", 3, "inspect"],
      ["C:\\w\\B.java", 10, "compile"],
    ]);
  });

  it("完全同一条只留一条（同文件同行同原文）", () => {
    const out = mergeProblems([cp("C:\\w\\A.java", 5, "找不到符号")], [cd("C:\\w\\a.java", 5, "找不到符号 ")]);
    expect(out).toHaveLength(1);
  });

  it("同一行的两个不同错误都要留", () => {
    // 按「同一行」去重会让修完一个的人以为全好了
    const out = mergeProblems([cp("C:\\w\\A.java", 5, "错误一")], [cd("C:\\w\\A.java", 5, "错误二")]);
    expect(out).toHaveLength(2);
  });

  it("警告不算进错误数", () => {
    const list = mergeProblems([cp("C:\\w\\A.java", 1)], [{ ...cd("C:\\w\\A.java", 2), severity: "warning" }]);
    expect(list).toHaveLength(2);
    expect(countErrors(list)).toBe(1);
  });

  it("info 原样透传，不抹成 warning，也不算错误", () => {
    // jdt.ls 的「未使用的导入 / 命名建议」是提示：以前在这里被抹平，界面只能显示成警告
    const list = mergeProblems([], [cd("C:\\w\\A.java", 3, "未使用的导入", "info")]);
    expect(list).toHaveLength(1);
    expect(list[0].severity).toBe("info");
    expect(countErrors(list)).toBe(0);
  });

  it("空输入不炸", () => {
    expect(mergeProblems(undefined, [])).toEqual([]);
  });
});

describe("nextProblem", () => {
  const list = mergeProblems([cp("A.java", 10), cp("A.java", 20), cp("B.java", 5)], []);

  it("从中间往后走", () => {
    expect(nextProblem(list, { path: "A.java", line: 10 }, 1)?.line).toBe(20);
  });

  it("同一行上的问题不算「之后」（否则按一下没反应）", () => {
    expect(nextProblem(list, { path: "A.java", line: 20 }, 1)?.path).toBe("B.java");
  });

  it("走到尾从头再来", () => {
    expect(nextProblem(list, { path: "B.java", line: 5 }, 1)?.line).toBe(10);
  });

  it("往回走", () => {
    expect(nextProblem(list, { path: "A.java", line: 20 }, -1)?.line).toBe(10);
  });

  it("在最前面往回走绕到最后", () => {
    expect(nextProblem(list, { path: "A.java", line: 5 }, -1)?.path).toBe("B.java");
  });

  it("没有当前位置时给第一条 / 最后一条", () => {
    expect(nextProblem(list, null, 1)?.line).toBe(10);
    expect(nextProblem(list, null, -1)?.line).toBe(5);
  });

  it("列表为空返回 null", () => {
    expect(nextProblem([], { path: "A.java", line: 1 }, 1)).toBeNull();
  });

  it("info 不参与跳转：往后、往前都直接跳过", () => {
    // A.java 10(error) 12(info) 20(error)：从 10 往后该落到 20，不是 12
    const mixed = mergeProblems(
      [cp("A.java", 10), cp("A.java", 20)],
      [cd("A.java", 12, "未使用的导入", "info")],
    );
    expect(mixed).toHaveLength(3);
    expect(nextProblem(mixed, { path: "A.java", line: 10 }, 1)?.line).toBe(20);
    // 从 20 往前也该落到 10
    expect(nextProblem(mixed, { path: "A.java", line: 20 }, -1)?.line).toBe(10);
  });

  it("只剩 info 时返回 null（没有可跳转的目标）", () => {
    const only = mergeProblems([], [cd("A.java", 5, "命名建议", "info")]);
    expect(nextProblem(only, null, 1)).toBeNull();
    expect(nextProblem(only, { path: "A.java", line: 1 }, -1)).toBeNull();
  });
});
