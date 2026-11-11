import { describe, expect, it } from "vitest";
import { relativeDisplay, renderReviewNotes } from "./reviewNotes";

describe("relativeDisplay", () => {
  it("工作区内的路径显示成相对路径（Windows 反斜杠也认）", () => {
    expect(relativeDisplay("D:\\work\\newar\\src\\A.java", "D:\\work\\newar")).toBe("src/A.java");
  });
  it("工作区外的路径保持绝对路径", () => {
    expect(relativeDisplay("E:/other/A.java", "D:/work/newar")).toBe("E:/other/A.java");
  });
  it("没有 root 时只归一分隔符", () => {
    expect(relativeDisplay("C:\\a\\b.java", null)).toBe("C:/a/b.java");
  });
  it("只差一个前缀词的路径不算工作区内（不切出半个目录名）", () => {
    // root 是 D:/work，文件在 D:/workbench 下：前缀相同但不在同一目录边界
    expect(relativeDisplay("D:\\workbench\\src\\A.java", "D:\\work")).toBe("D:/workbench/src/A.java");
  });
  it("root 带尾分隔符也认", () => {
    expect(relativeDisplay("D:\\work\\newar\\src\\A.java", "D:\\work\\newar\\")).toBe("src/A.java");
  });
});

describe("renderReviewNotes", () => {
  it("空列表返回空串", () => {
    expect(renderReviewNotes([])).toBe("");
  });

  it("带 file:line、代码块与批注，且不含任何自动发送指令", () => {
    const md = renderReviewNotes([{ path: "D:/w/src/A.java", line: 12, text: "int n = 1;\n", comment: "这个字段长度要核对" }], "D:/w");
    expect(md).toContain("src/A.java:12");
    expect(md).toContain("```java");
    expect(md).toContain("int n = 1;");
    expect(md).toContain("> 这个字段长度要核对");
    expect(md).not.toContain("```\n\n```"); // 尾部换行被削掉，不会多出空代码块
  });

  it("SQL 文件用 sql 围栏，多条按顺序", () => {
    const md = renderReviewNotes([
      { path: "D:/w/a.sql", line: 1, text: "select 1" },
      { path: "D:/w/B.java", line: 8, text: "class B {}" },
    ], "D:/w");
    expect(md).toContain("```sql");
    expect(md.indexOf("a.sql:1")).toBeLessThan(md.indexOf("B.java:8"));
  });
});
