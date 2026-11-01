import { describe, expect, it } from "vitest";
import { REFACTOR_KINDS, newNameSpan, refactorParams } from "./refactorPlan";

describe("refactorParams", () => {
  const range = {
    start: { line: 3, character: 8 },
    end: { line: 4, character: 20 },
  };

  it("命令名原样下发，目标文档的 uri 留空交给后端填", () => {
    const p = refactorParams("extractVariable", range, 4, true);
    expect(p.command).toBe("extractVariable");
    expect(p.commandArguments).toEqual([]);
    // 空串是刻意的：前端算出的 file:// 与后端 path_to_uri 形态不一致，前缀替换换不掉
    expect((p.context as { textDocument: { uri: string } }).textDocument.uri).toBe("");
    expect((p.context as { range: unknown }).range).toEqual(range);
    expect(p.options).toEqual({ tabSize: 4, insertSpaces: true });
  });

  it("四种提取共用一个形状，只有 command 不同", () => {
    const shapes = (Object.keys(REFACTOR_KINDS) as (keyof typeof REFACTOR_KINDS)[]).map((k) => {
      const p = refactorParams(k, range, 2, false);
      return { command: p.command, options: p.options, context: p.context };
    });
    for (const s of shapes) {
      expect(s.options).toEqual({ tabSize: 2, insertSpaces: false });
      expect(s.context).toEqual(refactorParams("extractMethod", range, 2, false).context);
    }
    expect(new Set(shapes.map((s) => s.command)).size).toBe(4);
  });
});

describe("newNameSpan", () => {
  const rename = (offset: unknown, length: unknown) => ({
    command: {
      command: "java.action.rename",
      arguments: [{ offset, length, uri: "file:///D:/ws/A.java" }],
    },
  });

  it("取联动改名的偏移与长度", () => {
    expect(newNameSpan(rename(134, 3))).toEqual({ offset: 134, length: 3 });
  });

  it("偏移 0 是合法位置（文件开头），不能当成缺省值丢掉", () => {
    expect(newNameSpan(rename(0, 5))).toEqual({ offset: 0, length: 5 });
  });

  it("没有改名命令（提取方法给的是默认名）返回 null", () => {
    expect(newNameSpan({ command: undefined })).toBeNull();
    expect(newNameSpan({ command: { command: "something.else", arguments: [{ offset: 1, length: 1 }] } })).toBeNull();
  });

  it("参数缺失或类型不对一律不选中，不能把字符串偏移硬转成数字", () => {
    expect(newNameSpan({})).toBeNull();
    expect(newNameSpan({ command: { command: "java.action.rename" } })).toBeNull();
    expect(newNameSpan(rename("134", 3))).toBeNull();
    expect(newNameSpan(rename(134, undefined))).toBeNull();
  });

  it("负数偏移、零长度、小数都拒绝", () => {
    expect(newNameSpan(rename(-1, 3))).toBeNull();
    expect(newNameSpan(rename(10, 0))).toBeNull();
    expect(newNameSpan(rename(1.5, 3))).toBeNull();
    expect(newNameSpan(rename(10, 2.5))).toBeNull();
  });
});
