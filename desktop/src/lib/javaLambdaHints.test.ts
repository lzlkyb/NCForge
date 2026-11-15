import { describe, expect, it } from "vitest";
import { javaHoverParameterType, javaLambdaParameters } from "./javaLambdaHints";
describe("Java8隐式lambda参数类型", () => {
  it("读取单参数、括号多参数、跨行及$标识符的准确位置", () => {
    const text = "items.map(value -> value); fn = (first,\n second) -> first; fn2 = $value -> $value;";
    const result = javaLambdaParameters(text, 0, text.length);
    expect(result.map(parameter => parameter.name)).toEqual(["value", "first", "second", "$value"]);
    for (const parameter of result) expect(text.slice(parameter.start, parameter.start + parameter.name.length)).toBe(parameter.name);
  });
  it("不请求已有显式类型的lambda、无参数lambda或注释/字符串中的伪代码", () => {
    const text = '(String value) -> value; (int first, int second) -> first; () -> 1; "fake -> fake"; /* other -> other */';
    expect(javaLambdaParameters(text, 0, text.length)).toEqual([]);
  });
  it("可见行从多行lambda中间开始时仍只提示可见参数，且最多8个", () => {
    const text = "fn = (first,\n second) -> first;\n" + Array.from({ length: 20 }, (_, index) => `x${index} -> x${index}`).join(";");
    const result = javaLambdaParameters(text, text.indexOf(" second"), text.length);
    expect(result[0].name).toBe("second"); expect(result).toHaveLength(8);
  });
  it("从真实变量声明形态的MarkupContent、MarkedString及纯文本读取类型", () => {
    expect(javaHoverParameterType({ kind: "markdown", value: "```java\nString value - demo.Demo\n```" }, "value")).toBe("String");
    expect(javaHoverParameterType([{ language: "java", value: "java.util.List<String> values" }], "values")).toBe("java.util.List<String>");
    expect(javaHoverParameterType("int[] values", "values")).toBe("int[]");
    expect(javaHoverParameterType("final String $value", "$value")).toBe("String");
  });
  it("没有匹配参数的语义声明时不猜类型，也不把文档句子或方法签名当类型", () => {
    expect(javaHoverParameterType(null, "value")).toBeNull();
    expect(javaHoverParameterType("String other", "value")).toBeNull();
    expect(javaHoverParameterType("public String method(String value)", "value")).toBeNull();
    expect(javaHoverParameterType("This parameter is named value", "value")).toBeNull();
  });
});
