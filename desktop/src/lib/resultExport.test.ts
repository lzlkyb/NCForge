import { describe, expect, it } from "vitest";
import { guessTable, sqlLiteral, toCsv, toInList, toInsert, toMarkdown, toTsv } from "./resultExport";
import type { ColumnMeta } from "./dbApi";

const cols: ColumnMeta[] = [
  { name: "CODE", type: "VARCHAR2(40)", precision: 40, scale: 0 },
  { name: "NNUM", type: "NUMBER(28,8)", precision: 28, scale: 8 },
];
const rows = [
  ["A'1", "2"],
  ["B,2", null],
  ["A'1", "3"],
];

describe("复制为", () => {
  it("TSV 的 NULL 写空、换行压成空格", () => {
    expect(toTsv(cols, [["a\nb", null]])).toBe("CODE\tNNUM\na b\t");
  });

  it("CSV 带引号转义", () => {
    expect(toCsv(cols, rows).split("\r\n")[2]).toBe('"B,2",');
  });

  it("INSERT 数字列不加引号、NULL 写关键字", () => {
    expect(toInsert("t", cols, [rows[1]])).toBe("insert into t (CODE, NNUM) values ('B,2', null);");
    expect(sqlLiteral("2", "NUMBER(28,8)")).toBe("2");
    expect(sqlLiteral("0010", "CHAR(4)")).toBe("'0010'");
  });

  it("IN 列表去重跳过 NULL", () => {
    expect(toInList(cols, rows, 0)).toBe("CODE in ('A''1', 'B,2')");
    expect(toInList(cols, rows, 1)).toBe("NNUM in (2, 3)");
  });

  it("IN 超过 1000 个要拆", () => {
    const many = Array.from({ length: 1001 }, (_, i) => [String(i), null]);
    expect(toInList(cols, many, 0)).toContain("\n or CODE in ('1000')");
  });

  it("Markdown 数字列右对齐", () => {
    expect(toMarkdown(cols, [rows[1]]).split("\n")[1]).toBe("| --- | ---: |");
  });

  it("猜表名", () => {
    expect(guessTable("select * from aier.bd_material where 1=1")).toBe("aier.bd_material");
    expect(guessTable("select 1")).toBe("表名");
  });
});
