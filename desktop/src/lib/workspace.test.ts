import { describe, expect, it } from "vitest";
import {
  baseName,
  dirName,
  isConflictError,
  joinPath,
  languageOf,
  remapPath,
  splitFileName,
  validateEntryName,
} from "./workspace";

describe("workspace 路径与语言工具", () => {
  it("joinPath 用反斜杠拼接，不重复分隔符", () => {
    expect(joinPath("C:\\work\\aier", "newar")).toBe("C:\\work\\aier\\newar");
    expect(joinPath("C:\\", "work")).toBe("C:\\work");
  });

  it("baseName 兼容两种分隔符", () => {
    expect(baseName("C:\\a\\b\\VoucherBO.java")).toBe("VoucherBO.java");
    expect(baseName("a/b/c.xml")).toBe("c.xml");
    expect(baseName("plain")).toBe("plain");
  });

  it("languageOf 按扩展名选语言，NC 元数据文件按 xml", () => {
    expect(languageOf("x\\A.java")).toBe("java");
    expect(languageOf("x\\module.upm")).toBe("xml");
    expect(languageOf("x\\.classpath")).toBe("xml");
    expect(languageOf("x\\a.PROPERTIES")).toBe("ini");
    expect(languageOf("x\\Makefile")).toBe("plaintext");
  });

  it("isConflictError 只认 CONFLICT 前缀", () => {
    expect(isConflictError("CONFLICT: 文件在磁盘上已被其他程序修改")).toBe(true);
    expect(isConflictError(new Error("写临时文件失败"))).toBe(false);
  });

  it("dirName 取父目录，没有分隔符时返回空串", () => {
    expect(dirName("C:\\a\\b\\A.java")).toBe("C:\\a\\b");
    expect(dirName("plain")).toBe("");
  });

  it("remapPath 换掉属于改名目录的那一段（忽略大小写）", () => {
    const from = "C:\\w\\newar\\modules\\gl";
    const to = "C:\\w\\newar\\modules\\gl2";
    expect(remapPath(from, from, to)).toBe(to);
    expect(remapPath("C:\\w\\newar\\modules\\gl\\A.java", from, to)).toBe(
      "C:\\w\\newar\\modules\\gl2\\A.java",
    );
    // Windows 路径不分大小写：大小写不同也要能对上
    expect(remapPath("C:\\W\\NEWAR\\MODULES\\GL\\A.java", from, to)).toBe(
      "C:\\w\\newar\\modules\\gl2\\A.java",
    );
    // 前缀相同但不是子目录的（gl 与 glx）不能误伤
    expect(remapPath("C:\\w\\newar\\modules\\glx\\A.java", from, to)).toBe(
      "C:\\w\\newar\\modules\\glx\\A.java",
    );
  });

  it("validateEntryName 与后端同规则", () => {
    for (const bad of ["", "  ", " a.java", "a.java ", "a/b.java", "a:b.java", "a?b.java", "a|b.java", "a.b.", "con", "CON.java", "lpt9.txt"]) {
      expect(validateEntryName(bad), `应拒绝 ${JSON.stringify(bad)}`).not.toBeNull();
    }
    for (const ok of ["NewVoucherBO.java", "nc.voucher", "接口-转换.xml", "a b.txt", "console.java", "条目"]) {
      expect(validateEntryName(ok), `应通过 ${JSON.stringify(ok)}`).toBeNull();
    }
  });

  it("splitFileName 拆主名与扩展名，点开头的整体算主名", () => {
    expect(splitFileName("VoucherBO.java")).toEqual({ stem: "VoucherBO", ext: ".java" });
    expect(splitFileName(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
    expect(splitFileName("Makefile")).toEqual({ stem: "Makefile", ext: "" });
    expect(splitFileName("a.tar.gz")).toEqual({ stem: "a.tar", ext: ".gz" });
  });
});
