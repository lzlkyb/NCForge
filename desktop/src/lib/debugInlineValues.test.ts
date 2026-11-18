import { describe, expect, it } from "vitest";
import { inlineValueHints } from "./debugInlineValues";
import type { DapScope, DapVariable } from "./debug";

const scope = (ref: number, name = "Local Variables"): DapScope => ({ name, variablesReference: ref, expensive: false });
const variable = (name: string, value: string): DapVariable => ({ name, value, variablesReference: 0 });

describe("暂停行内联变量值", () => {
  it("按作用域顺序列局部变量，this 与空值跳过", () => {
    const hints = inlineValueHints(
      { line: 12 },
      [scope(1), scope(2, "Static Fields")],
      {
        1: [variable("i", "3"), variable("this", "Caps@1b6d3586"), variable("total", "6")],
        2: [variable("MAX", "100")],
      },
    );
    expect(hints).toEqual([{ line: 12, label: "i = 3, total = 6, MAX = 100" }]);
  });

  it("空名字 / 空值 / 变量还没拉到（无该引用）都不产生文案", () => {
    const hints = inlineValueHints({ line: 5 }, [scope(1), scope(9)], {
      1: [variable("", "x"), variable("ok", "  "), variable("real", "1")],
      // 引用 9 没有数据：异步展开未完成
    });
    expect(hints).toEqual([{ line: 5, label: "real = 1" }]);
  });

  it("没有任何可显示变量时返回空（不画空尾巴）", () => {
    expect(inlineValueHints({ line: 5 }, [], {})).toEqual([]);
    expect(inlineValueHints({ line: 5 }, [scope(1)], { 1: [variable("this", "X@1")] })).toEqual([]);
    expect(inlineValueHints({ line: 0 }, [scope(1)], { 1: [variable("i", "1")] })).toEqual([]);
  });

  it("值里的折行压平、超长截断带省略号", () => {
    const hints = inlineValueHints({ line: 7 }, [scope(1)], {
      1: [variable("sql", "select\n  a,\n  b from t"), variable("big", "x".repeat(60))],
    });
    expect(hints[0].label).toBe("sql = select a, b from t, big = xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…");
  });

  it("变量个数与整条长度都有上限", () => {
    const many = Array.from({ length: 12 }, (_, n) => variable(`v${n}`, String(n)));
    const hints = inlineValueHints({ line: 3 }, [scope(1)], { 1: many });
    expect(hints[0].label).toBe("v0 = 0, v1 = 1, v2 = 2, v3 = 3, v4 = 4, v5 = 5, v6 = 6, v7 = 7");

    const long = Array.from({ length: 8 }, () => variable("name", "y".repeat(48)));
    const capped = inlineValueHints({ line: 3 }, [scope(1)], { 1: long }, { maxLabelLen: 40 });
    expect(capped[0].label.length).toBeLessThanOrEqual(40);
    expect(capped[0].label.endsWith("…")).toBe(true);
  });
});
