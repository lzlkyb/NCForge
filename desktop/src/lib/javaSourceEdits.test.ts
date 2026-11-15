import { describe, expect, it } from "vitest";
import { mergeJavaSourceEdits } from "./javaSourceEdits";
const edit = (text: string, start = 0, end = start) => ({ range: { start: { line: start, character: 0 }, end: { line: end, character: 0 } }, newText: text });
describe("原快照成员编辑合并", () => {
  it("去重并合并同位置插入，一次应用不会漂移", () => {
    const a = edit("get() {}\n"), b = edit("set() {}\n");
    expect(mergeJavaSourceEdits([{ changes: { a: [a] } }, { changes: { a: [a, b] } }]).changes?.a).toEqual([edit("get() {}\nset() {}\n")]);
    expect(a.newText).toBe("get() {}\n");
  });
  it("documentChanges也参与合并，非空重叠拒绝", () => {
    expect(mergeJavaSourceEdits([{ documentChanges: [{ textDocument: { uri: "a" }, edits: [edit("x")] }] }]).changes?.a).toEqual([edit("x")]);
    expect(() => mergeJavaSourceEdits([{ changes: { a: [edit("x", 0, 3), edit("y", 1, 2)] } }])).toThrow("重叠");
  });
});
