/**
 * CSV / TSV 解析的边界。
 *
 * 这些用例都来自"真实文件会怎么恶心你"：Excel 的引号与 BOM、格子里的逗号和换行、
 * 末尾空行、分号分隔的欧洲区导出。解析错了的表现是"导进去的列全错位"，
 * 而那时候数据已经进库了——所以只测纯函数，不测到界面。
 */
import { describe, expect, it } from "vitest";

import { autoMap, guessDelimiter, parseCsv } from "./csvParse";

describe("parseCsv", () => {
  it("逗号分隔 + CRLF + 去 BOM", () => {
    const r = parseCsv("\uFEFFID,NAME\r\n1,张三\r\n2,李四\r\n");
    expect(r.delimiter).toBe(",");
    expect(r.headers).toEqual(["ID", "NAME"]);
    expect(r.rows).toEqual([
      ["1", "张三"],
      ["2", "李四"],
    ]);
    expect(r.lineCount).toBe(3);
  });

  it("引号里的逗号不拆列", () => {
    const r = parseCsv('A,B\n1,"x,y"\n');
    expect(r.rows).toEqual([["1", "x,y"]]);
  });

  it("引号里的双引号翻倍还原", () => {
    const r = parseCsv('A\n"say ""hi"""\n');
    expect(r.rows).toEqual([['say "hi"']]);
  });

  it("引号里的换行不算换行", () => {
    const r = parseCsv('A,B\n"l1\nl2",2\n');
    expect(r.rows).toEqual([["l1\nl2", "2"]]);
  });

  it("制表符分隔（TSV）能被猜出来", () => {
    const r = parseCsv("ID\tNAME\n1\t张三\n");
    expect(r.delimiter).toBe("\t");
    expect(r.rows).toEqual([["1", "张三"]]);
  });

  it("分号分隔的欧洲区 CSV", () => {
    const r = parseCsv("ID;NAME\n1;x\n");
    expect(r.delimiter).toBe(";");
    expect(r.rows).toEqual([["1", "x"]]);
  });

  it("跳过空行但记下条数", () => {
    const r = parseCsv("A,B\n1,2\n,\n\n3,4\n");
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(r.blankLines).toBe(2);
  });

  it("文件不以换行结尾时最后一行也算", () => {
    // 手工编辑过的 CSV 常常最后一行没换行，漏掉就是少导一行数据
    const r = parseCsv("A,B\n1,2");
    expect(r.rows).toEqual([["1", "2"]]);
  });

  it("空字段保留成空串（后端会写成 null）", () => {
    const r = parseCsv("A,B,C\n1,,3\n");
    expect(r.rows).toEqual([["1", "", "3"]]);
  });

  it("强制指定分隔符时不再猜", () => {
    const r = parseCsv("A,B\n1,2\n", "\t");
    expect(r.delimiter).toBe("\t");
    expect(r.headers).toEqual(["A,B"]);
  });
});

describe("guessDelimiter", () => {
  it("制表符优先于逗号（TSV 单元格里可能有逗号）", () => {
    expect(guessDelimiter("a\tb\tc,d")).toBe("\t");
  });
  it("没有分隔符时回落到逗号", () => {
    expect(guessDelimiter("onlyone")).toBe(",");
  });
});

describe("autoMap", () => {
  it("忽略大小写、下划线、空格自动对上", () => {
    const cols = [{ name: "BD_MATERIAL" }, { name: "MAKEDATE" }];
    expect(autoMap(["bdmaterial", "make_date"], cols)).toEqual([0, 1]);
  });

  it("对不上的留 -1，不瞎猜", () => {
    // 猜错列比不猜更危险：把名字写进日期列，插进去就是一串脏数据
    expect(autoMap(["备注", "ID"], [{ name: "ID" }])).toEqual([-1, 0]);
  });

  it("空表头不参与匹配", () => {
    expect(autoMap(["", "ID"], [{ name: "ID" }])).toEqual([-1, 0]);
  });
});
