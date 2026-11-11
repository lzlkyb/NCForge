import { describe, expect, it } from "vitest";
import {
  applyOffsetEdits,
  classHeaderHasSupertype,
  hoverIsStaticFinal,
  isAssignmentTarget,
  isQualifiedName,
  leadingIdentifiers,
  literalType,
  matchParen,
  parseExtractedDeclaration,
  planParameterEdits,
  syntaxProblem,
  uniqueParamName,
} from "./refactorParamPlan";

describe("syntaxProblem", () => {
  it.each([
    ['"ic"', null],
    ["100", null],
    ["Const.MODULE", null],
    ["a + b", null],
    ['"a(b)" + X', null],
    ["x == 1", null],
  ])("%s 可以", (expr, want) => {
    expect(syntaxProblem(expr)).toBe(want);
  });

  it.each([
    ["i++", "自增"],
    ["--i", "自增"],
    ["x = 1", "赋值"],
    ["x += 1", "赋值"],
    ["new Date()", "new"],
    ["foo(1)", "方法调用"],
    ["a.b(c)", "方法调用"],
    ["this.x", "this"],
    ["x -> x", "lambda"],
    ["String::valueOf", "lambda"],
    ["a\nb", "单行"],
    ["  ", "没有选中"],
  ])("%s 被拒绝", (expr, why) => {
    expect(syntaxProblem(expr)).toContain(why);
  });

  it("字符串里的括号和等号不算", () => {
    expect(syntaxProblem('"x = foo(1)"')).toBeNull();
  });
});

describe("literalType", () => {
  it.each([
    ['"ic"', "String"],
    ["'a'", "char"],
    ["true", "boolean"],
    ["100", "int"],
    ["-5", "int"],
    ["100L", "long"],
    ["1.5", "double"],
    ["1e3", "double"],
    ["2f", "float"],
    ["0xFF", "int"],
    ["0xFFL", "long"],
  ])("%s → %s", (expr, want) => {
    expect(literalType(expr)).toBe(want);
  });

  it("null 和非字面量没有类型", () => {
    expect(literalType("null")).toBeNull();
    expect(literalType("a + 1")).toBeNull();
    expect(literalType("X")).toBeNull();
  });
});

describe("标识符与限定名", () => {
  it("限定名", () => {
    expect(isQualifiedName("A.B.C")).toBe(true);
    expect(isQualifiedName("A.B()")).toBe(false);
    expect(isQualifiedName("1")).toBe(false);
  });

  it("只取成员选择之前的标识符，跳过关键字和数字里的字母", () => {
    const ids = leadingIdentifiers("a.b + c * 2L + 1e3 + (int) d").map((i) => i.name);
    expect(ids).toEqual(["a", "c", "d"]);
  });

  it("字符串里的单词不算标识符", () => {
    expect(leadingIdentifiers('"hello world" + x').map((i) => i.name)).toEqual(["x"]);
  });
});

describe("isAssignmentTarget", () => {
  it("赋值 / 自增的目标", () => {
    const t = "count = 5; i++; --j; if (k == 1) {}";
    const at = (s: string) => {
      const i = t.indexOf(s);
      return isAssignmentTarget(t, i, i + s.length);
    };
    expect(at("count")).toBe(true);
    expect(at("i")).toBe(true);
    expect(at("j")).toBe(true);
    expect(at("k")).toBe(false);
  });
});

describe("uniqueParamName", () => {
  it("首字母小写、避开文件里已有标识符", () => {
    expect(uniqueParamName("Module", "int a;")).toBe("module");
    expect(uniqueParamName("module", "String module; module2 = 1;")).toBe("module3");
  });

  it("不合法或关键字退回 param", () => {
    expect(uniqueParamName("1x", "")).toBe("param");
    expect(uniqueParamName("class", "")).toBe("param");
  });
});

describe("parseExtractedDeclaration", () => {
  it("读出类型与变量名，兼容 final 与泛型", () => {
    expect(parseExtractedDeclaration(["String string = "])).toEqual({ type: "String", name: "string" });
    expect(parseExtractedDeclaration(["final int i = "])).toEqual({ type: "int", name: "i" });
    expect(parseExtractedDeclaration(["\t\tMap<String, List<Integer>> map = "])).toEqual({
      type: "Map<String, List<Integer>>",
      name: "map",
    });
  });

  it("不是声明就跳过", () => {
    expect(parseExtractedDeclaration(["foo(bar);", "x = 1"])).toBeNull();
  });
});

describe("hoverIsStaticFinal", () => {
  it("static 与 final 同时在", () => {
    expect(hoverIsStaticFinal("```java\npublic static final String MODULE\n```")).toBe(true);
    expect(hoverIsStaticFinal("private String name")).toBe(false);
    expect(hoverIsStaticFinal("private static int n")).toBe(false);
  });
});

describe("classHeaderHasSupertype", () => {
  it("只看类声明头，不看类体里的 extends", () => {
    expect(classHeaderHasSupertype("public class A extends B {", 0)).toBe(true);
    expect(classHeaderHasSupertype("class A implements I, J {", 0)).toBe(true);
    expect(classHeaderHasSupertype('class A { String s = "extends"; <T extends X> void m() {} }', 0)).toBe(false);
    expect(classHeaderHasSupertype("class A {", 0)).toBe(false);
  });
});

describe("matchParen", () => {
  it("跳过字符串与注释里的括号", () => {
    const t = 'f("a)" /* ) */ , \')\' // )\n, g(1))';
    expect(matchParen(t, 1)).toBe(t.length - 1);
  });

  it("没配对返回 -1", () => {
    expect(matchParen("f(a", 1)).toBe(-1);
    expect(matchParen("abc", 0)).toBe(-1);
  });
});

describe("planParameterEdits", () => {
  const src = [
    "class A {",
    "  void run() { go(); }",
    "  String name(int a) {",
    '    return "ic" + a;',
    "  }",
    "  void use() { name(1); name(2); }",
    "}",
  ].join("\n");

  const at = (s: string, from = 0) => src.indexOf(s, from);
  const plan = (extra: Partial<Parameters<typeof planParameterEdits>[0]> = {}) => {
    const exprStart = at('"ic"');
    return planParameterEdits({
      text: src,
      exprStart,
      exprEnd: exprStart + 4,
      name: "module",
      type: "String",
      methodName: "name",
      openParen: at("(int a)"),
      calls: [at("name(1)"), at("name(2)")],
      ...extra,
    });
  };

  it("改签名、换掉表达式、调用点补参数", () => {
    const p = plan();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const out = applyOffsetEdits(src, p.edits);
    expect(out).toContain("String name(int a, String module) {");
    expect(out).toContain('return module + a;');
    expect(out).toContain('name(1, "ic"); name(2, "ic");');
    // 新参数名的偏移指向结果文本里的那个名字
    expect(out.slice(p.nameOffset, p.nameOffset + 6)).toBe("module");
  });

  it("方法没有参数时不加逗号", () => {
    const s = "class A { String n() { return \"x\"; } void u() { n(); } }";
    const es = s.indexOf('"x"');
    const p = planParameterEdits({
      text: s,
      exprStart: es,
      exprEnd: es + 3,
      name: "p",
      type: "String",
      methodName: "n",
      openParen: s.indexOf("()"),
      calls: [s.lastIndexOf("n()")],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const out = applyOffsetEdits(s, p.edits);
    expect(out).toContain('String n(String p) { return p; }');
    expect(out).toContain('void u() { n("x"); }');
    expect(out.slice(p.nameOffset, p.nameOffset + 1)).toBe("p");
  });

  it("调用点排在声明前面也能算对新参数名的偏移", () => {
    const s = "class A { void u() { n(1); } String n(int a) { return \"x\"; } }";
    const es = s.indexOf('"x"');
    const p = planParameterEdits({
      text: s,
      exprStart: es,
      exprEnd: es + 3,
      name: "tag",
      type: "String",
      methodName: "n",
      openParen: s.indexOf("(int a)"),
      calls: [s.indexOf("n(1)")],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const out = applyOffsetEdits(s, p.edits);
    expect(out).toContain('n(1, "x")');
    expect(out.slice(p.nameOffset, p.nameOffset + 3)).toBe("tag");
  });

  it("可变参数、非调用的引用、对不上的位置一律放弃", () => {
    const varargs = "class A { void m(String... xs) { f(\"a\"); } }";
    const es = varargs.indexOf('"a"');
    const r = planParameterEdits({
      text: varargs, exprStart: es, exprEnd: es + 3, name: "p", type: "String", methodName: "m",
      openParen: varargs.indexOf("(String"), calls: [],
    });
    expect(r.ok).toBe(false);

    const ref = "class A { void m(int a) { f(\"a\"); } void u() { run(this::m); } }";
    const es2 = ref.indexOf('"a"');
    const r2 = planParameterEdits({
      text: ref, exprStart: es2, exprEnd: es2 + 3, name: "p", type: "String", methodName: "m",
      openParen: ref.indexOf("(int a)"), calls: [ref.indexOf("m)")],
    });
    expect(r2.ok).toBe(false);

    const r3 = plan({ calls: [at("name(1)") + 1] });
    expect(r3.ok).toBe(false);
  });

  it("表达式不在方法体里（在参数列表里）拒绝", () => {
    const s = "class A { void m(int a) { } }";
    const p = planParameterEdits({
      text: s, exprStart: s.indexOf("int"), exprEnd: s.indexOf("int") + 3, name: "p", type: "int",
      methodName: "m", openParen: s.indexOf("(", 10), calls: [],
    });
    expect(p.ok).toBe(false);
  });
});
