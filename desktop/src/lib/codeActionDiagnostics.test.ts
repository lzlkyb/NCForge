import { describe, expect, it } from "vitest";
import {
  hasProblemId,
  pickCodeActionDiagnostics,
  rangesIntersect,
  type SourceDiagnostic,
} from "./codeActionDiagnostics";

/** 造一条诊断。默认带可解析 code —— 无 code 的场景各用例自己覆盖。 */
function diag(
  line: number,
  code: string | number | undefined = "1610612995",
  endChar = 10,
): SourceDiagnostic {
  return {
    range: { start: { line, character: 0 }, end: { line, character: endChar } },
    message: `问题 ${String(code)} @${line}`,
    severity: 1,
    source: "Java",
    code,
  };
}

const at = (line: number, character = 3) => ({
  start: { line, character },
  end: { line, character },
});

describe("hasProblemId：口径必须与服务端 getProblemId 一致", () => {
  it("十进制字符串与数字都认", () => {
    expect(hasProblemId("1610612995")).toBe(true);
    expect(hasProblemId(1610612995)).toBe(true);
    expect(hasProblemId("-5")).toBe(true);
  });

  it("🔴 解析不出非 0 整数的一律不认（服务端会给 0，随后被 process 丢弃）", () => {
    // 这几条是真实会出现的：ecj/自定义诊断用语义化 code，不是 problem id
    expect(hasProblemId("unused")).toBe(false);
    expect(hasProblemId("")).toBe(false);
    expect(hasProblemId("   ")).toBe(false);
    expect(hasProblemId(undefined)).toBe(false);
    expect(hasProblemId(0)).toBe(false);
    expect(hasProblemId("0")).toBe(false);
    expect(hasProblemId(Number.NaN)).toBe(false);
    expect(hasProblemId(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("🔴 十六进制字符串不认：服务端 parseInt 不带 radix，会抛异常后给 0", () => {
    expect(hasProblemId("0x10000181")).toBe(false);
  });

  it("小数字符串不认（服务端 parseInt 会截断，但字面量不是整数的不该混进来）", () => {
    expect(hasProblemId("1.5")).toBe(false);
  });
});

describe("rangesIntersect", () => {
  it("包含与部分重叠都算相交", () => {
    const d = diag(5).range;
    expect(rangesIntersect(d, { start: { line: 5, character: 2 }, end: { line: 5, character: 4 } })).toBe(true);
    expect(rangesIntersect(d, { start: { line: 5, character: 8 }, end: { line: 6, character: 0 } })).toBe(true);
  });

  it("🔴 端点相接算相交：光标停在单词末尾也要能取到修复", () => {
    const d = diag(5, "1", 10).range; // [5:0, 5:10]
    expect(rangesIntersect(d, at(5, 10))).toBe(true);
    expect(rangesIntersect(d, at(5, 0))).toBe(true);
  });

  it("完全不相离的不算", () => {
    const d = diag(5).range;
    expect(rangesIntersect(d, at(4, 99))).toBe(false);
    expect(rangesIntersect(d, at(6, 0))).toBe(false);
    expect(rangesIntersect(d, at(5, 11))).toBe(false);
  });
});

describe("pickCodeActionDiagnostics", () => {
  it("🔴 空诊断进 → 空数组出（这正是修复前的状态：121 个 quickfix 全失效）", () => {
    expect(pickCodeActionDiagnostics([], at(5))).toEqual([]);
  });

  it("🔴 有相交且有 code 的诊断必须被带上，且 code 原样保留", () => {
    const got = pickCodeActionDiagnostics([diag(5, "1610612995")], at(5));
    expect(got).toHaveLength(1);
    // code 不能被丢掉也不能被改型：服务端按它匹配 problem id
    expect(got[0].code).toBe("1610612995");
    expect(got[0].range).toEqual(diag(5).range);
  });

  it("数字型 code 原样保留，不字符串化", () => {
    const got = pickCodeActionDiagnostics([diag(5, 1610612995)], at(5));
    expect(got[0].code).toBe(1610612995);
  });

  it("🔴 只带相交的：服务端不做 range 过滤，不筛就会给别处的修复", () => {
    const got = pickCodeActionDiagnostics([diag(3, "1"), diag(5, "2"), diag(9, "3")], at(5));
    expect(got.map((d) => d.code)).toEqual(["2"]);
  });

  it("🔴 无可解析 code 的不带：传过去服务端解析成 0 后丢弃，等于白占位", () => {
    // ⚠️ 「没有 code」这条不能写 `diag(5, undefined)`：JS 默认参数对 undefined 生效，
    // 会拿到默认的 "1610612995" 而不是真的缺字段（本用例第一版就这么假红过）。
    const noCode: SourceDiagnostic = { ...diag(5, "7") };
    delete noCode.code;
    const got = pickCodeActionDiagnostics(
      [diag(5, "unused"), noCode, diag(5, "0"), diag(5, "7")],
      at(5),
    );
    expect(got.map((d) => d.code)).toEqual(["7"]);
  });

  it("同一 problem id 只带一条（服务端自己也去重，这里先去一遍）", () => {
    const got = pickCodeActionDiagnostics([diag(5, "7"), diag(5, "7"), diag(5, 7)], at(5));
    expect(got).toHaveLength(1);
  });

  it("不同 problem id 都要带上，顺序按原顺序", () => {
    const got = pickCodeActionDiagnostics([diag(5, "7"), diag(5, "8"), diag(5, "9")], at(5));
    expect(got.map((d) => d.code)).toEqual(["7", "8", "9"]);
  });

  it("超上限截断，且截断后仍都是相交且有 code 的", () => {
    const many = Array.from({ length: 100 }, (_, i) => diag(5, String(i + 1)));
    const got = pickCodeActionDiagnostics(many, at(5), 8);
    expect(got).toHaveLength(8);
    expect(got.every((d) => hasProblemId(d.code))).toBe(true);
  });

  it("🔴 全是别处的诊断时返回空，而不是把全部塞进去", () => {
    expect(pickCodeActionDiagnostics([diag(1, "1"), diag(2, "2")], at(50))).toEqual([]);
  });

  it("severity 与 source 一并带上（服务端按 severity 判 isError）", () => {
    const got = pickCodeActionDiagnostics([diag(5, "7")], at(5));
    expect(got[0].severity).toBe(1);
    expect(got[0].source).toBe("Java");
  });
});