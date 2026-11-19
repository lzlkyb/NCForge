import { expect, it } from "vitest";
import { svnDiffLanguage } from "./svnDiffLanguage";
import { languageOfFormat } from "./fileFormats";

const XML_HEAD = '<?xml version="1.0"?>\n<module name="so"><component/></module>';

it("diff 语言与代码页同一真源：upm/bmf/rest 不再落 plaintext", () => {
  expect(svnDiffLanguage("META-INF/x.upm", XML_HEAD)).toBe("xml");
  expect(svnDiffLanguage("model/x.bmf", XML_HEAD)).toBe("xml");
  expect(svnDiffLanguage("api/x.rest", XML_HEAD)).toBe("xml");
  expect(svnDiffLanguage("templet/x.btf", XML_HEAD)).toBe("xml");
  expect(svnDiffLanguage("cfg/x.json", "{}")).toBe("json");
  expect(svnDiffLanguage("src/A.java", "class A {}")).toBe("java");
});

it("空工作副本（删除）用 BASE 正文嗅探；两侧都空退回 plaintext", () => {
  expect(svnDiffLanguage("api/x.rest", "")).toBe("plaintext");
  expect(svnDiffLanguage("api/x.rest", XML_HEAD)).toBe("xml");
});

it("任意路径与真源逐字一致（防再次分叉）", () => {
  for (const path of ["a.java", "a.upm", "a.bmf", "a.rest", "a.unknown", "a.sql", "a.properties", "a.jsp"]) {
    expect(svnDiffLanguage(path, XML_HEAD)).toBe(languageOfFormat(path, XML_HEAD));
    expect(svnDiffLanguage(path)).toBe(languageOfFormat(path));
  }
});