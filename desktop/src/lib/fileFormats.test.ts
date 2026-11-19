import { describe, expect, it } from "vitest";
import { fileFormat, languageOfFormat } from "./fileFormats";

const XML_HEAD = '<?xml version="1.0" encoding="gbk"?>\n<beans><component id="x"/></beans>';

describe("格式表：newar 工程实测扩展名全覆盖（2026-11-19 盘点 22591 文件）", () => {
  it("主力文本格式都有着色，不落 plaintext", () => {
    const direct: Record<string, string> = {
      java: "java", xml: "xml", upm: "xml", bmf: "xml", bpf: "xml",
      properties: "ini", prefs: "ini", sql: "sql", html: "html", css: "css",
      js: "javascript", md: "markdown", json: "json", jsp: "html",
      xsd: "xml", xsl: "xml", wsdl: "xml", svg: "xml", fxml: "xml",
      project: "xml", classpath: "xml", module_prj: "ini", dependency: "ini",
      txt: "plaintext", log: "plaintext",
    };
    for (const [ext, language] of Object.entries(direct)) {
      expect(languageOfFormat(`a/b.${ext}`), ext).toBe(language);
    }
  });

  it("rest/aop/mbe/mbp 与长尾 NC 设计模型：XML 正文嗅探为 xml", () => {
    for (const ext of ["rest", "aop", "mbe", "mbp", "umf", "fnf", "bcf", "crf", "func", "menu", "baf", "btc", "stb", "btf", "qtf"]) {
      expect(languageOfFormat(`designmodel/x.${ext}`, XML_HEAD), ext).toBe("xml");
      expect(fileFormat(`x.${ext}`).badge, ext).toBeTruthy();
    }
  });

  it("反例：嗅探格式的非 XML 正文退回 plaintext，不错着色", () => {
    for (const ext of ["rest", "umf", "btf", "qtf", "menu"]) {
      expect(languageOfFormat(`x.${ext}`, "SELECTION_PATH=0\nfoo=bar"), ext).toBe("plaintext");
      expect(languageOfFormat(`x.${ext}`, ""), ext).toBe("plaintext");
    }
    // 前导注释后才是 XML 声明：仍认 XML
    expect(languageOfFormat("x.umf", `<!-- 说明 -->\n${XML_HEAD}`)).toBe("xml");
    // 字符串里的假开头不算
    expect(languageOfFormat("x.rest", "not xml <fake")).toBe("plaintext");
  });

  it("二进制与归档保持 plaintext（另有专门通道）", () => {
    for (const ext of ["class", "jar", "zip", "xls", "png", "otf", "woff2"]) {
      expect(languageOfFormat(`x.${ext}`), ext).toBe("plaintext");
    }
  });

  it("未知扩展名落通用文件；隐藏工程元数据也有归属", () => {
    expect(fileFormat("x.unknownext").id).toBe("file");
    expect(languageOfFormat(".module_prj", "# comment\nmodule.name=so")).toBe("ini");
    expect(languageOfFormat(".dependency", "SELECTION_PATH=0")).toBe("ini");
  });

  it("upm/bmf 的图标与徽标保留（文件树可辨识）", () => {
    expect(fileFormat("META-INF/x.upm").badge).toBe("UPM");
    expect(fileFormat("x.bmf").badge).toBe("BMF");
    expect(fileFormat("x.umf").badge).toBe("UMF");
    expect(fileFormat("x.btf").badge).toBe("BTF");
  });
});