import { describe, expect, it } from "vitest";
import { javaGenerationModel } from "./javaGenerationModel";
import { generate } from "./javaCodeGen";

describe("在实际类中生成成员", () => {
  it("注解方法后生成构造器仍初始化全部未赋值final字段", () => {
    const text = 'class A {\n\t@SuppressWarnings(value = "unchecked")\n\tpublic void work() {}\n\tprivate final String token;\n\tprivate int value;\n\tA(String token) { this.token = token; }\n}';
    const parsed = javaGenerationModel(text, 5, 8)!;
    const constructor = generate("constructor", { fields: parsed.fields, methods: parsed.methods, className: parsed.name, indent: "\t" });
    expect(constructor).toContain("public A(String token, int value)");
    expect(constructor).toContain("this.token = token;");
    expect(constructor).toContain("this.value = value;");
  });
  it("内层泛型类只读取自己的字段与方法，插入位置属于内层类", () => {
    const text = "package nc.a;\nclass Outer {\n\tprivate String outer;\n\tstatic class Inner<T> {\n\t\tprivate T value;\n\t\tpublic T getValue() { return value; }\n\t}\n}";
    const inner = javaGenerationModel(text, 5, 8);
    expect(inner?.name).toBe("Inner");
    expect(inner?.fields.map(field => field.name)).toEqual(["value"]);
    expect(inner?.bodyEndLine).toBe(6);
    expect(inner?.baseIndent).toBe("\t");
    expect(generate("getters", { fields: inner!.fields, methods: inner!.methods, className: inner!.name, indent: "\t", baseIndent: inner!.baseIndent })).toBe("");
    expect(generate("setters", { fields: inner!.fields, className: inner!.name, indent: "\t", baseIndent: inner!.baseIndent })).toContain("\t\tpublic void setValue(T value)");
  });
  it("同一行声明不会因为内类同行而误选；文件头可选择外类", () => {
    const text = "class Outer { class Inner { int value; } }";
    expect(javaGenerationModel(text, 1, 8)?.name).toBe("Outer");
    expect(javaGenerationModel(text, 1, 35)?.name).toBe("Inner");
    expect(javaGenerationModel("package nc.a;\n" + text, 1, 2)?.name).toBe("Outer");
  });
});
