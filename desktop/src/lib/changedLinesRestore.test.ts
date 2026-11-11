import { describe, expect, it } from "vitest";
import { computeChanged } from "./changedLines";
import { revertEdit } from "./changedLinesRestore";

/** 忠实模拟 Monaco 的行列替换语义：(line,column) → 扁平偏移后整体替换。 */
function applyEdit(lines: string[], e: ReturnType<typeof revertEdit>): string {
  const flat = lines.join("\n");
  const offset = (line: number, column: number) =>
    lines.slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0) + column - 1;
  const from = offset(e.startLine, e.startColumn);
  const to = offset(e.endLine, e.endColumn);
  return flat.slice(0, from) + e.text + flat.slice(to);
}

describe("revertEdit", () => {
  it("替换块：整块换回基线文本", () => {
    const s = computeChanged("a\nb\nc\n", "a\nB\nc\n");
    const e = revertEdit(s.blocks[0], ["a", "B", "c", ""]);
    expect(e).toEqual({ startLine: 2, startColumn: 1, endLine: 2, endColumn: 2, text: "b" });
  });

  it("纯删除块：在插入点行首插回基线行（带换行）", () => {
    const s = computeChanged("a\nb\nc\nd\n", "a\nd\n");
    const e = revertEdit(s.blocks[0], ["a", "d", ""]);
    expect(e.startLine).toBe(2);
    expect(e.endLine).toBe(2);
    expect(e.startColumn).toBe(1);
    expect(e.endColumn).toBe(1);
    expect(e.text).toBe("b\nc\n");
  });

  it("纯新增块（后面还有内容）：连同行尾换行一起删", () => {
    const s = computeChanged("a\nd\n", "a\nb\nc\nd\n");
    const e = revertEdit(s.blocks[0], ["a", "b", "c", "d", ""]);
    expect(e).toMatchObject({ startLine: 2, endLine: 4, text: "" });
    expect(e.endColumn).toBe(1);
  });

  it("纯新增块在文件末尾：从上一行末尾开始删，不留空行", () => {
    // 两侧都不带结尾换行，新增块才真的落在最后一行；
    // 带结尾换行时末尾那个空行算「块后面还有内容」，走的是上一条分支。
    const s = computeChanged("a", "a\nb");
    const e = revertEdit(s.blocks[0], ["a", "b"]);
    expect(e.startLine).toBe(1);
    expect(e.startColumn).toBe(2);
    expect(e.endLine).toBe(2);
    expect(e.text).toBe("");
  });

  it("新增文件整篇还原后是空文本", () => {
    const s = computeChanged("", "a\nb\n");
    const e = revertEdit(s.blocks[0], ["a", "b", ""]);
    expect(e.startLine).toBe(1);
    expect(e.text).toBe("");
  });

  it("快照之后文件变短：行号夹到当前行数，不越界", () => {
    const s = computeChanged("a\nb\nc\nd\ne\n", "a\nb\nc\nD\nE\n");
    const e = revertEdit(s.blocks[0], ["a", "b"]);
    expect(e.endLine).toBeLessThanOrEqual(2);
    expect(e.startLine).toBeLessThanOrEqual(2);
  });
});

describe("还原后文本与基线一致", () => {
  it("替换 + 纯新增 + 纯删除三种形态都能退回基线", () => {
    const base = "a\nb\nc\n";
    const cases = ["a\nB\nc\n", "a\nb\nc\nd\n", "a\nc\n"];
    for (const cur of cases) {
      const s = computeChanged(base, cur);
      expect(s.blocks.length).toBeGreaterThan(0);
      for (const block of s.blocks) {
        const lines = cur.split("\n");
        const e = revertEdit(block, lines);
        // 真断言：整套编辑施加回去必须正好等于基线，而不是只检查范围合法
        expect(applyEdit(lines, e)).toBe(base);
      }
    }
  });

  it("删到文件末尾：删除三角夹在当前行数内，且还原后等于基线", () => {
    // 不带结尾换行时「下一个新侧行」是 行数+1，越界 range 会让 Monaco 整批丢装饰
    const s = computeChanged("a\nb", "a");
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0].deletedAt).toBe(1);
    const e = revertEdit(s.blocks[0], ["a"]);
    expect(applyEdit(["a"], e)).toBe("a\nb");
  });
});
