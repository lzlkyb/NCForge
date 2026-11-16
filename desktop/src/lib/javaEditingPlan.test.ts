import { describe, expect, it } from "vitest";
import { completeJavaStatement, javaDocPlan, javaImportPlan, pastedJavaTypes, postfixExpression } from "./javaEditingPlan";

describe("Java 后缀表达式", () => {
  it("保留方法调用、赋值左侧与逻辑比较的边界", () => {
    const line = "\tresult = query.load(1, other()).nn";
    expect(postfixExpression(line, line.length + 1)).toMatchObject({ expression: "query.load(1, other())", prefix: "nn" });
    const compare = "\tleft == right.if";
    expect(postfixExpression(compare, compare.length + 1)?.expression).toBe("left == right");
    expect(postfixExpression(line, line.length + 1)?.statement).toBe(false);
  });
  it("注释、字符串、类型声明不能被误改", () => {
    for (const line of ['// value.nn', 'String value = "value.nn', 'int value.nn']) expect(postfixExpression(line, line.length + 1)).toBeNull();
  });
});

describe("JavaDoc", () => {
  it("泛型参数、方法参数、返回值与异常来自真实签名", () => {
    const text = "class A {\n\tpublic <T> T load(java.util.Map<String, T> values, int count) throws Exception {\n\t}\n}";
    const plan = javaDocPlan(text, text.indexOf("public"));
    expect(plan?.text).toContain("@param <T>");
    expect(plan?.text).toContain("@param values");
    expect(plan?.text).toContain("@param count");
    expect(plan?.text).toContain("@return");
    expect(plan?.text).toContain("@throws Exception");
  });
  it("构造器和void方法不生成return，已有文档不重复生成", () => {
    expect(javaDocPlan("\tpublic A(int count) {", 3)?.text).not.toContain("@return");
    expect(javaDocPlan("\tpublic void run() {", 3)?.text).not.toContain("@return");
    expect(javaDocPlan("/** old */\npublic void run() {", 17)).toBeNull();
    expect(javaDocPlan("/** old */\n@Override\npublic void run() {", 30)).toBeNull();
  });
  it("字段初始化中的方法不误判方法，并保持CRLF", () => {
    const plan = javaDocPlan("class A {\r\n\tprivate Foo value = new Foo();\r\n}", 15);
    expect(plan?.text).toBe("\t/**\r\n\t *\r\n\t */\r\n");
  });
});

describe("Java语句补齐", () => {
  it("补右括号与分号，条件生成块并跟随缩进", () => {
    expect(completeJavaStatement('\tcall("x", other(', "\t")).toBe('\tcall("x", other());');
    expect(completeJavaStatement("\tif (ready", "\t")).toBe("\tif (ready) {\n\t\t\n\t}");
  });
  it("不改完整语句、未闭合字符串和行尾注释", () => {
    for (const line of ['call();', 'String name = "unterminated', 'call() // comment']) expect(completeJavaStatement(line, "\t")).toBeNull();
  });
  // 🔴 判「行尾有没有注释」只认状态机（遍历原文、认引号与转义）。
  // 旧实现额外拿 `trimmed.slice(code.trimEnd().length)` 做文本切片：blankLiterals
  // 把字符串内容换成空格后 trimEnd 会把尾段整块截掉，切出来的「尾段」其实是字符串本体，
  // 里面的 `http://` 被当成行注释 ⇒ 含 URL 的赋值行补分号失效。
  it("字符串里的 // 与 /* 不是注释，赋值行照样补分号", () => {
    expect(completeJavaStatement('String url = "http://nc.com/a"', "\t")).toBe('String url = "http://nc.com/a";');
    expect(completeJavaStatement('String s = "a /* b"', "\t")).toBe('String s = "a /* b";');
    expect(completeJavaStatement('String s = "a\\"//b"', "\t")).toBe('String s = "a\\"//b";');
    expect(completeJavaStatement("String c = '/'", "\t")).toBe("String c = '/';");
    expect(completeJavaStatement('log("http://x", other(', "\t")).toBe('log("http://x", other());');
  });
  it("真行尾注释仍然不补（块注释与转义后的引号都要认）", () => {
    for (const line of ['call() /* note */', 'call() // tail', 'String s = "a\\"b" // tail']) {
      expect(completeJavaStatement(line, "\t")).toBeNull();
    }
  });
});

describe("粘贴导入计划", () => {
  it("忽略字符串、注释、java.lang及已导入类型", () => {
    expect(pastedJavaTypes("import java.util.List;\nclass A {}", 'List values; Map other; String text = "Ghost"; // False')).toEqual(["Map"]);
  });
  it("保留同名冲突，补导入不写错java.lang子包", () => {
    expect(() => javaImportPlan("import first.Foo;\nclass A {}", ["second.Foo"])).toThrow("同名类");
    expect(javaImportPlan("class A {}", ["java.lang.reflect.Method"])?.text).toContain("import java.lang.reflect.Method;");
    expect(javaImportPlan("package nc.a;\r\nclass A {}", ["nc.a.Other", "java.lang.String", "java.util.List"])?.text).toBe("\r\nimport java.util.List;\r\n");
  });
  it("未选择或重复导入不产生改动，拒绝非法类名", () => {
    expect(javaImportPlan("import java.util.List;", ["java.util.List"])).toBeNull();
    expect(() => javaImportPlan("class A {}", ['java.util.List; class Evil {}'])).toThrow("不合法");
  });
});
