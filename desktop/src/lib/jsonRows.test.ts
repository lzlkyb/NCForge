import { describe, expect, it } from "vitest";
import { cellText, parseJsonRows } from "./jsonRows";

describe("parseJsonRows", () => {
  it("对象数组：表头取键的并集，缺的键补空", () => {
    const r = parseJsonRows('[{"code":"A","qty":1},{"code":"B","memo":"x"}]');
    expect(r.headers).toEqual(["code", "qty", "memo"]);
    expect(r.rows).toEqual([["A", "1", ""], ["B", "", "x"]]);
  });

  it("二维数组：表头是列1…列N，第一行不当标题", () => {
    const r = parseJsonRows('[["A","1"],["B","2"]]');
    expect(r.headers).toEqual(["列1", "列2"]);
    expect(r.rows).toEqual([["A", "1"], ["B", "2"]]);
  });

  it("参差不齐的二维数组按最宽的补空", () => {
    const r = parseJsonRows('[["A"],["B","2","3"]]');
    expect(r.headers).toHaveLength(3);
    expect(r.rows[0]).toEqual(["A", "", ""]);
  });

  it("单个对象当成一行", () => {
    const r = parseJsonRows('{"code":"A","qty":2}');
    expect(r.headers).toEqual(["code", "qty"]);
    expect(r.rows).toEqual([["A", "2"]]);
  });

  it("标量数组当一列", () => {
    const r = parseJsonRows('["A","B"]');
    expect(r.headers).toEqual(["值"]);
    expect(r.rows).toEqual([["A"], ["B"]]);
  });

  it("带 BOM 的文件也能读（记事本导出的 JSON 常见）", () => {
    expect(parseJsonRows("\uFEFF[{\"a\":1}]").rows).toEqual([["1"]]);
  });

  it("非法 JSON 报出原始原因，而不是静默空结果", () => {
    expect(() => parseJsonRows("[{a:1}]")).toThrow("不是合法的 JSON");
  });

  it("顶层既不是对象也不是数组时明确拒绝", () => {
    expect(() => parseJsonRows("42")).toThrow("顶层必须是");
  });

  it("空数组返回空表头空行", () => {
    expect(parseJsonRows("[]")).toMatchObject({ headers: [], rows: [] });
  });
});

describe("cellText", () => {
  it("null / undefined 变成空串（与 CSV 空字段同义）", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
  });

  it("嵌套结构退化成 JSON 文本，不丢信息", () => {
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });

  it("数字按原样转文本，不走本地化", () => {
    expect(cellText(1234.5)).toBe("1234.5");
  });
});
