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
  it("TSV 的 NULL 写空、换行引用后保留", () => {
    expect(toTsv(cols, [["a\nb", null]])).toBe('CODE\tNNUM\n"a\nb"\t');
  });

  it("CSV 带引号转义", () => {
    expect(toCsv(cols, rows).split("\r\n")[2]).toBe('"B,2",');
  });

  it("公式开头的值被中和，负数不受影响", () => {
    expect(toCsv(cols, [["=1+1", "-3"]])).toBe('CODE,NNUM\r\n"\'=1+1",-3');
    expect(toTsv(cols, [["@A1", "-3"]], false)).toBe('"\'@A1"\t-3');
    expect(toTsv(cols, [["-2+3", null]], false)).toBe('"\'-2+3"\t');
  });

  it("前导空白挡不住公式", () => {
    expect(toCsv(cols, [["  =1+1", "-3"]]).split("\r\n")[1]).toBe("\"'  =1+1\",-3");
    expect(toTsv(cols, [[" @A1", " -3"]], false)).toBe('"\' @A1"\t -3');
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

  it("旧 CSV 路径不额外添加 BOM，长主键和精密小数按文本保护", () => {
    const text = toCsv(cols, [["0012345678901234567890", "0.123456789012345678"]]);
    expect(text[0]).not.toBe("\uFEFF");
    expect(text).toContain('"\'0012345678901234567890","\'0.123456789012345678"');
  });

  it("旧 SQL 字面量保留时间的小数秒与时区，写回 NULL 接口不变", () => {
    expect(sqlLiteral(null, "VARCHAR2")).toBe("null");
    expect(sqlLiteral("2026-11-06", "DATE")).toContain("to_date('2026-11-06'");
    expect(sqlLiteral("2026-11-06 08:09:10.123456789", "TIMESTAMP(9)")).toContain("to_timestamp('2026-11-06 08:09:10.123456789'");
    expect(sqlLiteral("2026-11-06 08:09:10.123+08:00", "TIMESTAMP WITH TIME ZONE")).toContain("to_timestamp_tz(");
  });

  it("旧 Markdown 入口保留多行值和 NULL 标记", () => {
    expect(toMarkdown(cols, [["a|b\n<c>", null]])).toContain("| a\\|b<br>&lt;c&gt; | NULL |");
  });

  it("猜表名", () => {
    expect(guessTable("select * from aier.bd_material where 1=1")).toBe("aier.bd_material");
    expect(guessTable("select 1")).toBe("表名");
  });
});
