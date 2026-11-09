// 兜底路径的前提是解析器对「写了一半」的语句整条报错：
// 用真实 sql-formatter 跑一遍，库变了导致不再抛错时这里会立刻红，提醒重新评估。
import { describe, expect, it, vi } from "vitest";

vi.mock("./monacoSetup", () => ({
  monaco: {
    Range: class {
      constructor(
        readonly startLineNumber: number,
        readonly startColumn: number,
        readonly endLineNumber: number,
        readonly endColumn: number,
      ) {}
    },
  },
}));

import { fallbackFormatEdits } from "./sqlFormatTarget";

/** 只用到 getPositionAt 的假 model。 */
function modelOf(text: string) {
  return {
    getPositionAt: (offset: number) => {
      const lines = text.slice(0, offset).split("\n");
      return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
    },
  } as never;
}

describe("fallbackFormatEdits（真实解析器）", () => {
  it("括号没闭合的语句被跳过，其余照常排版", async () => {
    const text = "select 1 from dual;\nselect * from t where id in (1, 2;\nselect 3 from dual;";
    const result = await fallbackFormatEdits(modelOf(text), text, "plsql");
    expect(result.edits).toHaveLength(2);
    expect(result.skipped).toBe(1);
    expect(result.error).toContain("Parse error");
  });

  it("每条都能解析时全部给出编辑", async () => {
    const text = "select 1 from dual;\nselect 2 from dual;";
    const result = await fallbackFormatEdits(modelOf(text), text, "plsql");
    expect(result).toEqual({ edits: expect.any(Array), skipped: 0, error: null });
    expect(result.edits).toHaveLength(2);
  });
});
