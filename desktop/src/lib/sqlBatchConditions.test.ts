import { describe, expect, it } from "vitest";
import { sqlBatchCondition, sqlBatchTarget, sqlBatchValues } from "./sqlBatchConditions";

function target(before: string, selection = "001\n002", after = "") {
  const sql = before + selection + after;
  return { sql, selection, target: sqlBatchTarget(sql, before.length, before.length + selection.length, "plsql") };
}
function converted(before: string, selection: string, after = "", type = "VARCHAR2") {
  const state = target(before, selection, after);
  return state.sql.slice(0, state.target.start) + sqlBatchCondition(state.target.fieldRef, sqlBatchValues(selection, type), "plsql") + state.sql.slice(state.target.end);
}

describe("批量 IN 条件的 SQL 位置", () => {
  it.each([
    ["SELECT * FROM bd_material a WHERE a.code ", "a.code"],
    ["SELECT * FROM bd_material WHERE code ", "code"],
    ["SELECT * FROM bd_material WHERE bd_material.code ", "bd_material.code"],
    ['SELECT * FROM nc.bd_material "A" WHERE "A"."CODE" ', '"A"."CODE"'],
    ["SELECT * FROM bd_material a JOIN bd_org b ON a.pk_org=b.pk_org WHERE a.code ", "a.code"],
  ])("识别已写的字段：%s", (before, ref) => {
    const result = target(before).target;
    expect(result.fieldRef).toBe(ref); expect(result.source.table).toBe("bd_material");
  });

  it("现有 IN 括号内选择整列，替换包含字段和完整括号", () => {
    const before = "SELECT * FROM bd_material a WHERE a.code IN (\n";
    expect(converted(before, "001\nO'Reilly", "\n) AND a.dr=0;")).toBe("SELECT * FROM bd_material a WHERE a.code IN ('001', 'O''Reilly') AND a.dr=0;");
  });

  it("用屏蔽后的 SQL 确定来源，Excel 单引号不会吞掉后续语句", () => {
    expect(target("SELECT * FROM bd_material WHERE code ", "O'Reilly\nAB", " ORDER BY code").target.source.table).toBe("bd_material");
  });

  it.each([
    ["SELECT code ", " FROM bd_material"],
    ["SELECT * FROM bd_material WHERE length(code ", ")=1"],
    ["SELECT * FROM bd_material WHERE price * code ", ""],
    ["SELECT * FROM bd_material WHERE code", ""],
    ["SELECT * FROM bd_material WHERE price BETWEEN 1 AND code ", ""],
    ["SELECT * FROM bd_material WHERE code IN ('old', ", ")"],
    ["SELECT * FROM bd_material WHERE code IN (", ", 'old')"],
    ["SELECT * FROM bd_material WHERE code ", "+ 1"],
    ["SELECT * FROM bd_material WHERE (code ", ") = 1"],
    ["SELECT * FROM bd_material WHERE (code IN (", ")) + 1"],
    ["SELECT * FROM bd_material a JOIN bd_org b ON future.code ", " JOIN bd_material future ON future.code=a.code"],
    ["SELECT * FROM bd_material WHERE name='", "'"],
    ["SELECT * FROM bd_material WHERE code /*", "*/"],
    ["SELECT * FROM bd_material WHERE code NOT IN (", ")"],
    ["SELECT * FROM bd_material a JOIN bd_org b ON a.pk_org=b.pk_org WHERE code ", ""],
    ["WITH x AS (SELECT code FROM bd_material) SELECT * FROM x WHERE code ", ""],
    ["BEGIN SELECT * FROM bd_material WHERE code ", "; END;"],
  ])("拒绝不能安全重建的选区：%s", (before, after) => {
    expect(() => target(before, "001\n002", after)).toThrow();
  });

  it("在 AND 与外层 NOT 下拆分仍是一个完整条件", () => {
    const values = Array.from({ length: 1001 }, (_, i) => String(i));
    const output = converted("SELECT * FROM bd_material a WHERE a.dr=0 AND NOT (a.code IN (", values.join("\n"), "))");
    expect(output).toContain("AND NOT ((a.code IN (");
    expect(output).toContain("\n OR a.code IN ('1000')))");
    expect(output.endsWith(")))")).toBe(true);
  });
});

describe("选区值与字段类型", () => {
  it("文本保留前导零，转义单引号，去重保持原顺序", () => {
    expect(sqlBatchValues("001\r\nO'Reilly\r\n001\r\n002\r\n\r\n", "VARCHAR2(40)")).toEqual(["'001'", "'O''Reilly'", "'002'"]);
    expect(sqlBatchValues("'001'\n'O''Reilly'\n001", "NVARCHAR2")).toEqual(["'001'", "'O''Reilly'"]);
  });
  it("Excel 单元格的逗号、NULL 和 SQL 片段只作为文本", () => {
    expect(sqlBatchValues("A,B\nNULL\n1); DELETE FROM x; --", "VARCHAR2")).toEqual(["'A,B'", "'NULL'", "'1); DELETE FROM x; --'"]);
  });
  it("合法数字保留精度与字面值，没有浮点转换", () => {
    expect(sqlBatchValues("001\n+1.50\n-.5\n9007199254740993\n1e-20\n001", "NUMBER(38, 20)")).toEqual(["001", "+1.50", "-.5", "9007199254740993", "1e-20"]);
  });
  it.each(["'1'", "1+2", "1); DELETE FROM x; --", "NaN", "Infinity", "1,000", "1e", "0x10"])("拒绝非法数值：%s", value => {
    expect(() => sqlBatchValues(value, "NUMBER")).toThrow("无效数字");
  });
  it.each(["", "DATE", "TIMESTAMP", "CLOB", "UUID", "BOOLEAN"])("未知或不能用于此操作的类型不猜：%s", type => {
    expect(() => sqlBatchValues("001", type)).toThrow("字段类型");
  });
  it("空列和多列输入不会生成条件", () => {
    expect(() => sqlBatchValues("\n \n", "VARCHAR2")).toThrow("没有可用值");
    expect(() => sqlBatchValues("A\tB\nC\tD", "VARCHAR2")).toThrow("一列值");
  });
  it("Oracle 每组最多1000项，其他数据库与关键字大小写保留", () => {
    const values = Array.from({ length: 2001 }, (_, i) => String(i));
    const expression = sqlBatchCondition("a.id", values, "plsql", "lower");
    expect(expression.startsWith("(a.id in (")).toBe(true);
    expect(expression.match(/a\.id in \(([^)]+)\)/g)?.map(part => part.split(", ").length)).toEqual([1000, 1000, 1]);
    expect(expression.endsWith("a.id in (2000))")).toBe(true);
    expect(sqlBatchCondition("a.id", values.slice(0, 1000), "plsql").startsWith("a.id IN (")).toBe(true);
    expect(sqlBatchCondition("a.id", values, "postgresql")).not.toContain(" OR ");
  });
});
