import { describe, expect, it } from "vitest";
import { diagnosticSummaries } from "./diagnosticSummary";
import type { CodeDiag } from "./diagStore";
const diag = (line: number, severity: CodeDiag["severity"], message: string): CodeDiag => ({ path: "D:/A.java", column: 1, line, severity, message });
describe("行内诊断摘要", () => {
  it("同一行优先显示错误，并保留该行全部说明", () => {
    const [row] = diagnosticSummaries([diag(1, "warning", "警告"), diag(1, "error", "错误"), diag(1, "info", "说明")]);
    expect(row.severity).toBe("error"); expect(row.summary).toBe("错误（另 2 项）"); expect(row.detail).toBe("错误\n\n警告\n\n说明");
  });
  it("长诊断不扩大行内摘要，换行原文仍能完整阅读", () => {
    const message = "长错误\n".repeat(90), [row] = diagnosticSummaries([diag(1, "error", message)]);
    expect(row.summary.length).toBeLessThanOrEqual(97); expect(row.summary).not.toContain("\n"); expect(row.detail).toBe(message);
  });
  it("重复行不消耗额外可见行预算", () => {
    const rows = diagnosticSummaries([diag(1, "info", "a"), diag(1, "error", "b"), diag(2, "error", "c"), diag(3, "error", "d")], 2);
    expect(rows.map(row => row.line)).toEqual([1, 2]);
  });
});
