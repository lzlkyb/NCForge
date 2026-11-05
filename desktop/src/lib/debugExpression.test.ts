import { describe, expect, it } from "vitest";
import { expressionAt } from "./debugExpression";

describe("从源码行取悬停表达式", () => {
  it("光标在标识符中间时取整段访问/调用链", () => {
    const line = "int total = vo.getCode();";
    expect(expressionAt(line, 14)).toBe("vo.getCode()");
    expect(expressionAt(line, 7)).toBe("total");
  });

  it("空格与运算符是边界，空格处优先取左边表达式", () => {
    expect(expressionAt("a + b", 5)).toBe("b");
    // 光标停在 ')' 与 ';' 之间的空格上：取左边的调用
    expect(expressionAt("foo(bar)  ;", 9)).toBe("foo(bar)");
    expect(expressionAt("a + b", 3)).toBeNull();
  });

  it("单字符变量照常求值，关键词与字面量不弹提示", () => {
    expect(expressionAt("  i++;", 3)).toBe("i");
    expect(expressionAt("return value;", 3)).toBeNull();
    expect(expressionAt("x = 123;", 5)).toBeNull();
    expect(expressionAt('s = "abc";', 7)).toBeNull();
  });

  it("括号不平衡或脚本被截断时放弃", () => {
    expect(expressionAt("foo(bar", 2)).toBeNull();
    expect(expressionAt("foo(bar)", 2)).toBe("foo(bar)");
    expect(expressionAt("", 1)).toBeNull();
  });

  it("光标在行尾的点上时去掉调用点", () => {
    expect(expressionAt("vo.", 2)).toBe("vo");
    expect(expressionAt("abc", 99)).toBe("abc");
  });
});
