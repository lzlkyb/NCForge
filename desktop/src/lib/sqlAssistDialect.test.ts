import { describe, expect, it } from "vitest";
import { sqlAssistFunctions, sqlAssistFunctionsFor, sqlAssistKeywords } from "./sqlAssistDialect";

describe("Oracle 函数库", () => {
  const all = sqlAssistFunctions("plsql");

  it("覆盖 NC 日常常用函数，且无重名", () => {
    expect(all.length).toBeGreaterThanOrEqual(55);
    expect(new Set(all.map(f => f.name)).size).toBe(all.length);
  });

  it("每个函数都有中文说明", () => {
    for (const f of all) {
      expect(f.description, f.name).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it("无参函数不补括号占位（SYSDATE / USER 不是 SYSDATE()）", () => {
    // 由调用方保证 insertText：args 为空时默认模板必须回落成函数名本身。
    const noArgs = all.filter(f => f.args.length === 0);
    expect(noArgs.map(f => f.name)).toEqual(expect.arrayContaining(["SYSDATE", "USER"]));
  });

  it("七大类都有人：字符 / 正则 / 数值 / 日期 / 条件 / 分析 / 环境", () => {
    for (const name of ["SUBSTR", "INSTR", "REGEXP_LIKE", "MOD", "TRUNC", "ADD_MONTHS", "NVL2", "ROW_NUMBER", "LISTAGG", "USER", "SYS_CONTEXT"]) {
      expect(all.some(f => f.name === name), name).toBe(true);
    }
  });

  it("分析函数自带 OVER 片段", () => {
    const rowNumber = all.find(f => f.name === "ROW_NUMBER")!;
    expect(rowNumber.snippet).toBe("ROW_NUMBER() OVER (ORDER BY ${1:column})");
    const listagg = all.find(f => f.name === "LISTAGG")!;
    expect(listagg.snippet).toContain("WITHIN GROUP");
  });
});

describe("函数按子句收窄（只发生在无前缀时）", () => {
  it("无前缀：聚合与窗口函数只在 SELECT 后出现", () => {
    const inSelect = sqlAssistFunctionsFor("plsql", "select", false).map(f => f.name);
    const inWhere = sqlAssistFunctionsFor("plsql", "where", false).map(f => f.name);
    expect(inSelect).toContain("SUM");
    expect(inSelect).toContain("ROW_NUMBER");
    expect(inWhere).not.toContain("SUM");
    expect(inWhere).not.toContain("ROW_NUMBER");
    // WHERE 里最常用的条件 / 字符 / 日期函数必须在
    expect(inWhere).toEqual(expect.arrayContaining(["NVL2", "NULLIF", "TO_DATE", "SUBSTR", "TRUNC"]));
  });

  it("无前缀：INSERT 的 VALUES 里给 SYSDATE", () => {
    expect(sqlAssistFunctionsFor("plsql", "insert", false).map(f => f.name)).toContain("SYSDATE");
  });

  it("有前缀：全量给出，交前缀过滤（敲 to_ 时 where 里也要见到 TO_CHAR）", () => {
    expect(sqlAssistFunctionsFor("plsql", "where", true).length).toBe(sqlAssistFunctions("plsql").length);
    expect(sqlAssistFunctionsFor("plsql", "where", true).map(f => f.name)).toContain("TO_DATE");
  });

  it("其他方言也带 clauses，不会在无前缀时被整体收窄没了", () => {
    for (const dialect of ["mysql", "postgresql", "tsql", "sqlite", "db2"] as const) {
      const wide = sqlAssistFunctionsFor(dialect, "where", false);
      expect(wide.length, dialect).toBeGreaterThan(0);
    }
  });
});

describe("关键字仍按子句给", () => {
  it("where 给条件关键字，select 前给语句骨架", () => {
    expect(sqlAssistKeywords("where", "plsql")).toEqual(expect.arrayContaining(["AND", "OR", "IN", "EXISTS", "BETWEEN"]));
    expect(sqlAssistKeywords("other", "plsql")).toEqual(expect.arrayContaining(["SELECT", "FROM", "JOIN"]));
  });
});
