import { describe, expect, it } from "vitest";
import { failedRowsCsv, failedRowsName } from "./importReport";

const HEADERS = ["ID", "NAME"];

describe("失败行导出", () => {
  it("行号换算：文件第 2 行是第一条数据", () => {
    // 表头算第 1 行，所以 line=2 → rows[0]。差一位就会把上一行导出成坏行
    const csv = failedRowsCsv(HEADERS, [["1", "甲"]], [{ line: 2, error: "ORA-01722" }]);
    const [, first] = csv.split("\r\n");
    expect(first).toBe("2,1,甲,ORA-01722");
  });

  it("表头与列顺序照抄源文件，末尾追加错误列", () => {
    const csv = failedRowsCsv(HEADERS, [], []);
    expect(csv.split("\r\n")[0]).toBe("文件行号,ID,NAME,导入错误");
  });

  it("含逗号 / 引号 / 换行的值按 CSV 规则转义", () => {
    const csv = failedRowsCsv(HEADERS, [['a,b', 'x"y']], [{ line: 2, error: "第 1 列\n类型不符" }]);
    const line = csv.split("\r\n")[1];
    expect(line).toContain('"a,b"');
    expect(line).toContain('"x""y"');
    expect(line).toContain('"第 1 列\n类型不符"');
  });

  it("行号越界仍出这一行，并标注找不到原始数据", () => {
    // 丢掉这条错误 = 用户少修一行还查不出原因
    const csv = failedRowsCsv(HEADERS, [["1", "甲"]], [{ line: 9, error: "ORA-01438" }]);
    expect(csv).toContain("（未找到该行原始数据）ORA-01438");
  });

  it("以 = 开头的值加撇号，避免 Excel 当公式执行", () => {
    const csv = failedRowsCsv(HEADERS, [["=1+1", "甲"]], [{ line: 2, error: "e" }]);
    expect(csv.split("\r\n")[1]).toBe("2,'=1+1,甲,e");
  });

  it("文件名带表名与分钟级时间戳", () => {
    expect(failedRowsName("bd_material", new Date(2026, 10, 17, 19, 5))).toBe(
      "导入失败行-bd_material-20261117-1905.csv",
    );
  });
});
