import { describe, expect, it } from "vitest";
import {
  generate,
  joinGenerated,
  needsFields,
  skipReason,
  summarize,
  type GenKind,
  type GenOptions,
} from "./javaCodeGen";
import type { JavaField } from "./javaModel";

const f = (name: string, type: string, over: Partial<JavaField> = {}): JavaField => ({
  name,
  type,
  isStatic: false,
  isFinal: false,
  ...over,
});

const O = (fields: JavaField[]): GenOptions => ({ fields, className: "BillVO", indent: "\t" });

const FIELDS = [f("pk", "String"), f("flag", "boolean")];
const ALL: GenKind[] = ["constructor", "getters", "setters", "toString", "equals", "hashCode"];

describe("getter / setter", () => {
  it("boolean 走 isXxx，其余 getXxx", () => {
    const out = generate("getters", O(FIELDS));
    expect(out).toContain("public String getPk() {");
    expect(out).toContain("public boolean isFlag() {");
    expect(out).not.toContain("getFlag");
  });

  it("static 字段的访问器带 static", () => {
    const out = generate("getters", O([f("COUNT", "int", { isStatic: true })]));
    expect(out).toContain("public static int getCOUNT() {");
  });

  it("setter 跳过 static 与 final 字段", () => {
    const out = generate("setters", O([f("pk", "String"), f("ID", "long", { isFinal: true })]));
    expect(out).toContain("public void setPk(String pk) {");
    expect(out).not.toContain("setID");
  });
});

describe("constructor", () => {
  it("参数按字段顺序，static 不参与", () => {
    const out = generate("constructor", O([f("pk", "String"), f("N", "int", { isStatic: true })]));
    expect(out).toContain("public BillVO(String pk) {");
    expect(out).toContain("this.pk = pk;");
    expect(out).not.toContain("this.N");
  });

  it("没有可赋值的字段就不生成（免得产出一个空构造器）", () => {
    expect(generate("constructor", O([f("N", "int", { isStatic: true })]))).toBe("");
  });
});

describe("toString", () => {
  const lines = generate("toString", O(FIELDS)).split("\n");

  it("每行以 + 结尾：Java 不允许在操作数后面换行", () => {
    // 取 `return "BillVO{" +` 之后到 `'}';` 之前那段，逐行断言
    const start = lines.findIndex((l) => l.includes('return "BillVO{" +'));
    const end = lines.findIndex((l) => l.trim() === "'}';");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    for (const l of lines.slice(start + 1, end)) expect(l.endsWith("+")).toBe(true);
  });

  it("第一个字段不带头逗号，后续带", () => {
    expect(lines.join("\n")).toContain('"pk=" + pk +');
    expect(lines.join("\n")).toContain('", flag=" + flag +');
  });

  it("没有字段时给一个固定串，不留悬空的 +", () => {
    const out = generate("toString", O([]));
    expect(out).toContain('return "BillVO{}";');
    expect(out).not.toContain("+");
  });
});

describe("equals / hashCode", () => {
  it("equals 逐字段 Objects.equals，用 && 连（没有多参数重载）", () => {
    const out = generate("equals", O(FIELDS));
    expect(out).toContain("java.util.Objects.equals(pk, that.pk)");
    expect(out).toContain("&& java.util.Objects.equals(flag, that.flag)");
    // 逗号塞进同一个调用是引用比较，永远 false —— 这条就是防回归
    expect(out).not.toMatch(/Objects\.equals\([^)]*, [^)]*,/);
  });

  it("hashCode 列全部非 static 字段", () => {
    const out = generate("hashCode", O([...FIELDS, f("N", "int", { isStatic: true })]));
    expect(out).toContain("return java.util.Objects.hash(pk, flag);");
  });
});

describe("skipReason / summarize / joinGenerated", () => {
  it("没有字段时构造器与访问器给出解释，toString 不需要", () => {
    expect(skipReason("constructor", O([]))).toBe("类里没有字段");
    expect(skipReason("getters", O([]))).toBe("类里没有字段");
    expect(skipReason("toString", O([]))).toBeNull();
  });

  it("字段全不可写时 setter 的解释与 getter 不同", () => {
    const o = O([f("ID", "long", { isFinal: true })]);
    expect(skipReason("setters", o)).toBe("字段都是 static 或 final，不需要 setter");
    expect(skipReason("getters", o)).toBeNull();
  });

  it("needsFields 只对构造器与访问器为真", () => {
    expect(ALL.filter(needsFields)).toEqual(["constructor", "getters", "setters"]);
  });

  it("summarize 跳过不会生成项并报数量", () => {
    expect(summarize(ALL, O([]))).toBe("toString + equals + hashCode");
    expect(summarize(ALL, O(FIELDS))).toBe(
      "构造器 + 2 个 getter + 2 个 setter + toString + equals + hashCode",
    );
  });

  it("joinGenerated 补一个前导空行，并丢掉空段", () => {
    expect(joinGenerated([])).toBe("");
    expect(joinGenerated(["", "  "])).toBe("");
    expect(joinGenerated(["a\n", "b\n"])).toBe("\na\n\nb\n");
  });
});

describe("生成物整体可编译的形状", () => {
  it("六项全生成时花括号配平（至少不是肉眼可见的残句）", () => {
    const text = ALL.map((k) => generate(k, O(FIELDS))).join("\n");
    const open = (text.match(/\{/g) ?? []).length;
    const close = (text.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });
});
