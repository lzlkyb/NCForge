// @vitest-environment jsdom
/**
 * 断点条件 / 命中次数 / 日志消息的静态校验。
 *
 * 用例口径来自 java-debug 0.32.0 的实测（反编译确认）：
 * - condition 命中时才由 JDT 编译，语法错误运行时才炸 → 前端必须挡；
 * - hitCondition 只 Integer.parseInt，>=N / %N 静默按 0 处理；
 * - logMessage 原样拼进 Java 字符串字面量，英文引号 / 反斜杠 / 空 {} / 单独 % 都是地雷。
 */
import { describe, expect, it } from "vitest";
import {
  draftErrors,
  hasDraftErrors,
  validateCondition,
  validateHitCondition,
  validateLogMessage,
} from "./breakpointCondition";

describe("断点条件校验", () => {
  it("空 / 空白 = 没填条件，合法", () => {
    expect(validateCondition("")).toBeNull();
    expect(validateCondition("   ")).toBeNull();
  });

  it("合法表达式放行（含引号内等号、三元、方法引用、数组初始化器）", () => {
    const ok = [
      "vo.getCode() != null",
      "list.size() > 0 && ready",
      '"a".equals(x)',
      "x > 0 ? \"y\" : \"n\"",
      "list.stream().anyMatch(v -> v > 0)",
      "Objects::nonNull != null",
      "new BillVo().isValid()",
      "a == -1",
      "a != b",
      "a <= b && c >= d",
      "arr[0] > 1",
      "(a + b) * c > 0",
      "map.get(\"k\") != null",
      // 字符串字面量里的 = 与 : 不算赋值/冒号
      "s.contains(\"=\")",
      "key.contains(\":\")",
      // 花括号只在数组初始化器里出现，且不在开头 → 放行
      "Arrays.asList(new int[]{1,2}).size() > 0",
      "this.value != null",
    ];
    for (const expr of ok) expect(validateCondition(expr)).toBeNull();
  });

  it("引号没闭好 → 明确指出", () => {
    expect(validateCondition('s.equals("abc)')).toBe("表达式里有没闭好的引号");
  });

  it("括号不配对（多、少、类型错）→ 指出", () => {
    expect(validateCondition("foo(a, b")).toBe("表达式的圆括号 / 方括号不配对");
    expect(validateCondition("foo(a, b))")).toBe("表达式的圆括号 / 方括号不配对");
    expect(validateCondition("foo(a, b]")).toBe("表达式的圆括号 / 方括号不配对");
  });

  it("分号 = 粘了语句 → 拒绝", () => {
    expect(validateCondition("a > b; c > d")).toBe("表达式里不能有分号 ;：只支持单个表达式，不是语句");
  });

  it("换行 = 粘了代码段 → 拒绝", () => {
    expect(validateCondition("a > b\nc > d")).toBe("表达式不能跨行：只支持单个表达式");
  });

  it("赋值拒绝、比较放行", () => {
    expect(validateCondition("a = b")).toBe("表达式里不能用赋值（= / += 等）：只做判断，不要改值");
    expect(validateCondition("count += 1")).toBe("表达式里不能用赋值（= / += 等）：只做判断，不要改值");
    expect(validateCondition("i=-1")).toBe("表达式里不能用赋值（= / += 等）：只做判断，不要改值");
    expect(validateCondition("a == b")).toBeNull();
    expect(validateCondition("a >= b")).toBeNull();
    expect(validateCondition("a != b")).toBeNull();
  });

  it("语句开头关键字拒绝，new 放行", () => {
    expect(validateCondition("if (x > 0) return true;")).toContain("不能以 if 开头");
    expect(validateCondition("return x > 0")).toContain("不能以 return 开头");
    expect(validateCondition("while (true) {}")).toContain("不能以 while 开头");
    expect(validateCondition("new BillVo().isValid()")).toBeNull();
  });

  it("代码块开头拒绝", () => {
    expect(validateCondition("{ foo(); }")).toBe("表达式不能是代码块 { … }");
  });

  it("冒号只允许三元与方法引用", () => {
    // 裸 JSON 片段开头就是 { → 先按代码块拒；嵌在消息里的（payload={"a":1}）才轮到冒号规则
    expect(validateCondition('{"a":1}')).toContain("代码块");
    expect(validateCondition("a ? b : c")).toBeNull();
    expect(validateCondition("String::valueOf")).toBeNull();
    expect(validateCondition('x > 0 ? "y" : "n"')).toBeNull();
  });

  it("超长 → 拒绝", () => {
    expect(validateCondition("a && ".repeat(200) + "b")).toContain("太长了");
  });
});

describe("命中次数校验", () => {
  it("空 = 没填，合法", () => {
    expect(validateHitCondition("")).toBeNull();
    expect(validateHitCondition("  ")).toBeNull();
  });

  it("纯正整数放行", () => {
    expect(validateHitCondition("5")).toBeNull();
    expect(validateHitCondition("  12 ")).toBeNull();
  });

  it(">=N / %N 是适配器不支持的写法，明确拒绝（不静默）", () => {
    expect(validateHitCondition(">=5")).toContain("会被静默忽略");
    expect(validateHitCondition("%5")).toContain("会被静默忽略");
    expect(validateHitCondition(">5")).toContain("会被静默忽略");
  });

  it("0 与非数字拒绝", () => {
    expect(validateHitCondition("0")).toBe("命中次数至少为 1");
    expect(validateHitCondition("00")).toBe("命中次数至少为 1");
    expect(validateHitCondition("abc")).toBe("命中次数只支持正整数（如 5）");
    expect(validateHitCondition("5x")).toBe("命中次数只支持正整数（如 5）");
    expect(validateHitCondition("-1")).toBe("命中次数只支持正整数（如 5）");
  });
});

describe("日志消息校验", () => {
  it("空 / 纯文本合法；无占位符时 % 安全（不走 String.format）", () => {
    expect(validateLogMessage("")).toBeNull();
    expect(validateLogMessage("  ")).toBeNull();
    expect(validateLogMessage("hello world")).toBeNull();
    expect(validateLogMessage("进度 50% 完成")).toBeNull();
  });

  it("占位符写法合法", () => {
    expect(validateLogMessage("code = {vo.getCode()}")).toBeNull();
    expect(validateLogMessage("{a} and {b}")).toBeNull();
    // 占位符里的字符串字面量带引号也合法（进的是参数位，不是字面量）
    expect(validateLogMessage('{x.equals("a")}')).toBeNull();
    // %% 是 String.format 的转义，安全
    expect(validateLogMessage("50%% done {x}")).toBeNull();
  });

  it("空占位符拒绝", () => {
    expect(validateLogMessage("value = {}")).toBe("{} 里要写表达式：如 {vo.getCode()}");
    expect(validateLogMessage("value = {  }")).toBe("{} 里要写表达式：如 {vo.getCode()}");
  });

  it("占位符里不是表达式拒绝", () => {
    expect(validateLogMessage("{return x}")).toContain("不是合法表达式");
    expect(validateLogMessage("{a = b}")).toContain("不是合法表达式");
  });

  it("消息文本里的英文引号 / 反斜杠拒绝（会拼坏生成的 Java 代码）", () => {
    expect(validateLogMessage('say "hi"')).toContain("英文双引号");
    expect(validateLogMessage("path C:\\tmp")).toContain("反斜杠");
  });

  it("花括号不成对拒绝（适配器按 {表达式} 非贪婪匹配，会错位）", () => {
    expect(validateLogMessage("count={ {1,2} }")).not.toBeNull();
    expect(validateLogMessage("a } b")).toContain("花括号不成对");
    // 跨行占位符适配器的正则匹配不到，等同于不成对
    expect(validateLogMessage("{a\nb}")).not.toBeNull();
  });

  it("% 与占位符同时出现拒绝（% 是格式符）", () => {
    expect(validateLogMessage("50% {x}")).toContain("% 是格式符");
  });

  it("JSON 片段拒绝（花括号被当成占位符，冒号不在三元里）", () => {
    expect(validateLogMessage('payload={"a":1}')).toContain("不是合法表达式");
  });
});

describe("草稿整体校验", () => {
  it("三项组合与总判定", () => {
    expect(draftErrors({ condition: "a > b", hitCondition: "5", logMessage: "{x}" })).toEqual({
      condition: null,
      hitCondition: null,
      logMessage: null,
    });
    const bad = draftErrors({ condition: "a = b", hitCondition: ">=5", logMessage: 'say "hi"' });
    expect(bad.condition).toContain("赋值");
    expect(bad.hitCondition).toContain("静默忽略");
    expect(bad.logMessage).toContain("英文双引号");
    expect(hasDraftErrors(bad)).toBe(true);
    expect(hasDraftErrors(draftErrors({ condition: "", hitCondition: "", logMessage: "" }))).toBe(false);
  });
});
