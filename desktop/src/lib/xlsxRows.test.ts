import { describe, expect, it } from "vitest";
import { isXlsxFile, sheetToRows } from "./xlsxRows";

describe("sheetToRows", () => {
  it("第一行当表头，其余当数据", () => {
    const r = sheetToRows({ sheet: "Sheet1", rows: [["ID", "NAME"], ["1", "甲"], ["2", "乙"]] });
    expect(r.headers).toEqual(["ID", "NAME"]);
    expect(r.rows).toEqual([["1", "甲"], ["2", "乙"]]);
    expect(r.lineCount).toBe(3);
  });

  it("跳过开头的空行，标题行不会变成空表头", () => {
    const r = sheetToRows({ sheet: "S", rows: [["", ""], [], ["ID", "NAME"], ["1", "甲"]] });
    expect(r.headers).toEqual(["ID", "NAME"]);
    expect(r.rows).toEqual([["1", "甲"]]);
    expect(r.blankLines).toBe(2);
  });

  it("数据比表头宽时补「列N」，不静默丢掉多出来的列", () => {
    const r = sheetToRows({ sheet: "S", rows: [["ID"], ["1", "多出来"]] });
    expect(r.headers).toEqual(["ID", "列2"]);
    expect(r.rows[0]).toEqual(["1", "多出来"]);
  });

  it("空列名补成「列N」，短行补空串到表头宽度", () => {
    const r = sheetToRows({ sheet: "S", rows: [["ID", ""], ["1"]] });
    expect(r.headers).toEqual(["ID", "列2"]);
    // 短行补齐：不补的话 planImport 取到 undefined，写回时是漏列还是 NULL 说不清
    expect(r.rows[0]).toEqual(["1", ""]);
  });

  it("中间的空行跳过并计数，行号仍能对回文件", () => {
    const r = sheetToRows({ sheet: "S", rows: [["ID"], ["1"], [""], ["3"]] });
    expect(r.rows).toEqual([["1"], ["3"]]);
    expect(r.blankLines).toBe(1);
    expect(r.lineCount).toBe(3);
  });

  it("单元格首尾空格保留（与 CSV 同口径）", () => {
    const r = sheetToRows({ sheet: "S", rows: [["ID"], [" a "]] });
    expect(r.rows[0][0]).toBe(" a ");
  });

  it("整张表都是空的就返回空结果，不是空表头", () => {
    const r = sheetToRows({ sheet: "S", rows: [[], ["", ""]] });
    expect(r).toMatchObject({ headers: [], rows: [] });
  });
});

describe("isXlsxFile", () => {
  it("只认 xlsx / xlsm，旧版 xls 不冒充", () => {
    expect(isXlsxFile("a.XLSX")).toBe(true);
    expect(isXlsxFile("b.xlsm")).toBe(true);
    // .xls 是 BIFF 不是 zip，交给调用方给「另存为」的提示
    expect(isXlsxFile("c.xls")).toBe(false);
    expect(isXlsxFile("d.csv")).toBe(false);
  });
});
