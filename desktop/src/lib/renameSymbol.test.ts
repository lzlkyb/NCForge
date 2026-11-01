import { describe, expect, it } from "vitest";
import { applyLspEdits, groupEdits, type LspTextEdit } from "./renameEdits";

const edit = (line: number, ch: number, len: number, text: string): LspTextEdit => ({
  range: { start: { line, character: ch }, end: { line, character: ch + len } },
  newText: text,
});

describe("applyLspEdits", () => {
  const text = "class A {\n  void save() {}\n  void run() { save(); }\n}";

  it("同一行多处：从后往前改，前面的偏移不会被打乱", () => {
    // 行 2：`  void run() { save(); }`，save 在 15
    const out = applyLspEdits(text, [edit(2, 15, 4, "persist")]);
    expect(out).toContain("void run() { persist(); }");
  });

  it("跨行多处一起改", () => {
    const out = applyLspEdits(text, [edit(1, 7, 4, "persist"), edit(2, 15, 4, "persist")]);
    expect(out).toContain("void persist() {}");
    expect(out).toContain("persist();");
  });

  it("行号越界直接抛错，不把行列夹到文件末尾", () => {
    // 夹取会改写无关字符；清单与磁盘对不上时应当整体中止
    expect(() => applyLspEdits("a\nb", [edit(99, 0, 1, "x")])).toThrow(/越界/);
  });

  it("列越界直接抛错（只允许行尾之后那一格插入）", () => {
    expect(() => applyLspEdits("abc", [edit(0, 9, 1, "x")])).toThrow(/越界/);
    expect(applyLspEdits("abc", [edit(0, 3, 0, "d")])).toBe("abcd");
  });

  it("重叠的编辑直接抛错，不拼出乱七八糟的文本", () => {
    // 两个编辑都覆盖同一段：硬改会把两次替换叠在一起
    expect(() => applyLspEdits("foo bar", [edit(0, 0, 3, "AAA"), edit(0, 1, 3, "BBB")])).toThrow(/重叠/);
  });

  it("相邻但不重叠的编辑照常应用", () => {
    expect(applyLspEdits("foo bar", [edit(0, 0, 3, "AAA"), edit(0, 4, 3, "BBB")])).toBe("AAA BBB");
  });

  it("空编辑原样返回", () => {
    expect(applyLspEdits(text, [])).toBe(text);
  });
});

describe("groupEdits", () => {
  it("changes 形态按文件分组", () => {
    const { groups, skipped } = groupEdits({
      changes: {
        "C:\\w\\A.java": [edit(0, 0, 1, "x")],
        "C:\\w\\B.java": [edit(1, 2, 3, "y"), edit(2, 0, 1, "z")],
      },
    });
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.path.endsWith("B.java"))?.edits).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });

  it("documentChanges 形态也认", () => {
    const { groups } = groupEdits({ documentChanges: [{ textDocument: { uri: "C:\\w\\A.java" }, edits: [edit(0, 0, 1, "x")] }] });
    expect(groups.map((g) => g.path)).toEqual(["C:\\w\\A.java"]);
  });

  it("file:// 形式的 uri 转回路径", () => {
    const { groups } = groupEdits({ changes: { "file:///C:/w/A.java": [edit(0, 0, 1, "x")] } });
    expect(groups[0].path).toBe("C:\\w\\A.java");
  });

  it("jar 里的类改不了，列进 skipped 而不是假装成功", () => {
    const { groups, skipped } = groupEdits({ changes: { "jdt://contents/x.jar/A.class": [edit(0, 0, 1, "x")] } });
    expect(groups).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it("大小写不同的同一文件合并成一组", () => {
    const { groups } = groupEdits({
      changes: { "C:\\w\\A.java": [edit(0, 0, 1, "x")], "c:\\W\\a.JAVA": [edit(1, 0, 1, "y")] },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].edits).toHaveLength(2);
  });
});
