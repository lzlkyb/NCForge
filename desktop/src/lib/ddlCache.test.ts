import { beforeEach, describe, expect, it } from "vitest";
import { ddlCacheSize, ddlKey, dropDdl, readDdl, writeDdl } from "./ddlCache";

describe("ddlCache", () => {
  beforeEach(() => dropDdl());

  it("同一个名字在不同连接/schema/类型下互不命中", () => {
    writeDdl(ddlKey("c1", "gl_docfree2"), "A");
    expect(readDdl(ddlKey("c1", "GL_DOCFREE2"))).toBe("A");
    expect(readDdl(ddlKey("c2", "GL_DOCFREE2"))).toBeUndefined();
    expect(readDdl(ddlKey("c1", "GL_DOCFREE2", "INDEX"))).toBeUndefined();
    expect(readDdl(ddlKey("c1", "GL_DOCFREE2", null, "AIER633"))).toBeUndefined();
  });

  it("空串也是有效结果，不能被 falsy 判成未命中", () => {
    writeDdl(ddlKey("c1", "T"), "");
    expect(readDdl(ddlKey("c1", "T"))).toBe("");
  });

  it("dropDdl 只清指定连接", () => {
    writeDdl(ddlKey("c1", "T"), "1");
    writeDdl(ddlKey("c2", "T"), "2");
    dropDdl("c1");
    expect(readDdl(ddlKey("c1", "T"))).toBeUndefined();
    expect(readDdl(ddlKey("c2", "T"))).toBe("2");
  });

  it("超过上限淘汰最久未用的那条", () => {
    for (let i = 0; i < 120; i++) writeDdl(ddlKey("c", `T${i}`), String(i));
    expect(readDdl(ddlKey("c", "T0"))).toBe("0"); // 触碰后变成最近使用
    writeDdl(ddlKey("c", "EXTRA"), "x");
    expect(ddlCacheSize()).toBe(120);
    expect(readDdl(ddlKey("c", "T1"))).toBeUndefined();
    expect(readDdl(ddlKey("c", "T0"))).toBe("0");
    expect(readDdl(ddlKey("c", "EXTRA"))).toBe("x");
  });
});
