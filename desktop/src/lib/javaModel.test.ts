import { describe, expect, it } from "vitest";
import { blankLiterals, indentUnitOf, parseJava } from "./javaModel";

/** 字段 / 方法 / 嵌套类 / 字符串里带分号，四种情况一次覆盖。 */
const SRC = [
  "package nc.bs.foo;",
  "",
  "public class BillVO implements java.io.Serializable {",
  "\tprivate static final long serialVersionUID = 1L;",
  "\tprivate String pk;",
  "\t/** 注释里的 ; 和 { 不该影响解析 */",
  "\tprivate boolean flag = false;",
  "",
  "\tpublic String getPk() {",
  '\t\tString local = "x;y{z";',
  "\t\treturn pk;",
  "\t}",
  "",
  "\tclass Inner {",
  "\t\tprivate int hidden;",
  "\t}",
  "",
  "\tpublic void setPk(String pk) {",
  "\t\tthis.pk = pk;",
  "\t}",
  "}",
].join("\n");

describe("blankLiterals", () => {
  it("注释与字符串抹成空格，长度与换行保持不变", () => {
    const src = 'a; // x\nString s = "b;c";';
    const out = blankLiterals(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).not.toContain("x");
    expect(out).not.toContain("b;c");
    expect(out).toContain("a;");
  });
});

describe("parseJava", () => {
  const t = parseJava(SRC);

  it("认得出类名、包名与类型种类", () => {
    expect(t).not.toBeNull();
    expect(t?.name).toBe("BillVO");
    expect(t?.kind).toBe("class");
    expect(t?.packageName).toBe("nc.bs.foo");
  });

  it("只收类体第一层的字段：嵌套类的字段不算", () => {
    expect(t?.fields.map((f) => f.name)).toEqual(["serialVersionUID", "pk", "flag"]);
    expect(t?.fields.map((f) => f.type)).toEqual(["long", "String", "boolean"]);
  });

  it("修饰符落到 isStatic / isFinal", () => {
    const byName = Object.fromEntries((t?.fields ?? []).map((f) => [f.name, f]));
    expect(byName.serialVersionUID).toMatchObject({ isStatic: true, isFinal: true });
    expect(byName.pk).toMatchObject({ isStatic: false, isFinal: false });
  });

  it("类体第一层的方法带返回类型与参数，方法体里的局部变量不算字段", () => {
    expect(t?.methods).toEqual([
      { name: "getPk", returnType: "String", params: [] },
      { name: "setPk", returnType: "void", params: ["String pk"] },
    ]);
  });

  it("bodyEndLine 是类体收尾那一行（0 基）", () => {
    expect(t?.bodyEndLine).toBe(SRC.split("\n").length - 1);
  });

  it("接口也能解析，抽象方法照样收", () => {
    const i = parseJava("public interface Foo {\n\tString NAME = \"x\";\n\tvoid run();\n}");
    expect(i?.kind).toBe("interface");
    expect(i?.fields.map((f) => f.name)).toEqual(["NAME"]);
    expect(i?.methods.map((m) => m.name)).toEqual(["run"]);
  });

  it("不是 Java 源码就返回 null（没有类型声明）", () => {
    expect(parseJava("just some text")).toBeNull();
  });
});

describe("indentUnitOf", () => {
  it("有制表符就用制表符（NC 工程），否则四个空格", () => {
    expect(indentUnitOf("class A {\n\tint x;\n}")).toBe("\t");
    expect(indentUnitOf("class A {\n    int x;\n}")).toBe("    ");
  });
});
