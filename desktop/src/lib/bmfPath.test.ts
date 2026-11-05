import { describe, expect, it } from "vitest";
import { BMF_IDENT, normalizeBmfPath } from "./bmfPath";

describe("normalizeBmfPath", () => {
  it("去掉 Windows verbatim 前缀，反斜杠、大小写与尾部分隔符都归一", () => {
    expect(normalizeBmfPath("\\\\?\\D:\\work\\uapbd\\METADATA\\demo.bmf")).toBe("d:/work/uapbd/metadata/demo.bmf");
    expect(normalizeBmfPath("D:/work/UAPBD/METADATA/DEMO.BMF")).toBe("d:/work/uapbd/metadata/demo.bmf");
    expect(normalizeBmfPath("D:\\work\\uapbd\\METADATA\\")).toBe("d:/work/uapbd/metadata");
  });

  it("UNC verbatim 还原成双反斜杠路径", () => {
    expect(normalizeBmfPath("\\\\?\\UNC\\server\\share\\a.bmf")).toBe("//server/share/a.bmf");
  });
});

describe("BMF_IDENT", () => {
  it("只接受小写字母开头的标识符", () => {
    expect(BMF_IDENT.test("demo_1")).toBe(true);
    expect(BMF_IDENT.test("a")).toBe(true);
    expect(BMF_IDENT.test("Demo")).toBe(false);
    expect(BMF_IDENT.test("1demo")).toBe(false);
    expect(BMF_IDENT.test("demo-x")).toBe(false);
    expect(BMF_IDENT.test("中文")).toBe(false);
  });
});
