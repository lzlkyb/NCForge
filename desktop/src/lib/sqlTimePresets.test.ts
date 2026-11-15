import { afterEach, describe, expect, it, vi } from "vitest";
import { format, type SqlLanguage } from "sql-formatter";
import { snippetEscape } from "./sqlTemplates";
import { sqlTimePresets } from "./sqlTimePresets";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const get = (dialect: SqlLanguage, type = "DATE", upper = true) => sqlTimePresets("a.created", type, dialect, upper);
const find = (dialect: SqlLanguage, operator: string, type = "DATE") => get(dialect, type).find(item => item.operator === operator)!;
const dialects = ["plsql", "postgresql", "tsql", "mysql", "mariadb", "db2"] as const;

describe("数据库端常用时间条件", () => {
  it.each(dialects)("%s 提供四个完整半开区间并明确数据库时钟", dialect => {
    const items = get(dialect);
    expect(items.map(item => item.label)).toEqual(["今天", "本月", "上月", "近七天"]);
    for (const item of items) {
      expect(item.insertText).toBe(`a.created ${item.suffix}`);
      expect(item.insertText.match(/a\.created/g)).toHaveLength(2);
      expect(item.insertText).toMatch(/^a\.created >= .+ AND a\.created < .+\$0$/);
      expect(item.insertText).not.toContain("BETWEEN"); expect(item.insertText).not.toContain("<=");
      expect(item.hint).toContain("含起点不含终点"); expect(item.hint).toContain("数据库");
      expect(item.hint).toContain("时区"); expect(item.hint).toContain("执行 SQL 时由数据库计算");
    }
  });

  it.each([
    ["plsql", "a.created >= CAST(TRUNC(CURRENT_DATE) AS DATE) AND a.created < CAST(TRUNC(CURRENT_DATE) + 1 AS DATE)$0"],
    ["postgresql", "a.created >= CAST(CURRENT_DATE AS DATE) AND a.created < CAST(CURRENT_DATE + 1 AS DATE)$0"],
    ["tsql", "a.created >= CAST(GETDATE() AS DATE) AND a.created < DATEADD(DAY, 1, CAST(GETDATE() AS DATE))$0"],
    ["mysql", "a.created >= CURDATE() AND a.created < DATE_ADD(CURDATE(), INTERVAL 1 DAY)$0"],
    ["mariadb", "a.created >= CURDATE() AND a.created < DATE_ADD(CURDATE(), INTERVAL 1 DAY)$0"],
    ["db2", "a.created >= CURRENT DATE AND a.created < CURRENT DATE + 1 DAY$0"],
  ] as const)("%s 今天使用数据库零点至明天零点", (dialect, expression) => {
    expect(find(dialect, "TIME_TODAY").insertText).toBe(expression);
  });

  it.each([
    ["plsql", "TRUNC(CURRENT_DATE) - 6", "TRUNC(CURRENT_DATE) + 1"],
    ["postgresql", "CURRENT_DATE - 6", "CURRENT_DATE + 1"],
    ["tsql", "DATEADD(DAY, -6, CAST(GETDATE() AS DATE))", "DATEADD(DAY, 1, CAST(GETDATE() AS DATE))"],
    ["mysql", "DATE_SUB(CURDATE(), INTERVAL 6 DAY)", "DATE_ADD(CURDATE(), INTERVAL 1 DAY)"],
    ["mariadb", "DATE_SUB(CURDATE(), INTERVAL 6 DAY)", "DATE_ADD(CURDATE(), INTERVAL 1 DAY)"],
    ["db2", "CURRENT DATE - 6 DAYS", "CURRENT DATE + 1 DAY"],
  ] as const)("%s 近七天包括今天，按自然日而非过去168小时", (dialect, start, end) => {
    const item = find(dialect, "TIME_LAST_7_DAYS");
    expect(item.insertText).toContain(start); expect(item.insertText).toContain(end);
    expect(item.hint).toContain("含今天的七个自然日：六天前 00:00 至明天 00:00");
    expect(item.insertText).not.toMatch(/168|INTERVAL '?7|DATEADD\(DAY, -7/);
  });

  it.each([
    ["plsql", "TRUNC(CURRENT_DATE, 'MM')", "+ INTERVAL '1' MONTH", "- INTERVAL '1' MONTH"],
    ["postgresql", "DATE_TRUNC('month', CAST(CURRENT_DATE AS TIMESTAMP))", "+ INTERVAL '1 month'", "- INTERVAL '1 month'"],
    ["tsql", "DATEADD(DAY, 1 - DAY(CAST(GETDATE() AS DATE)), CAST(GETDATE() AS DATE))", "DATEADD(MONTH, 1,", "DATEADD(MONTH, -1,"],
    ["mysql", "DATE_SUB(CURDATE(), INTERVAL (DAYOFMONTH(CURDATE()) - 1) DAY)", "INTERVAL 1 MONTH", "INTERVAL 1 MONTH"],
    ["mariadb", "DATE_SUB(CURDATE(), INTERVAL (DAYOFMONTH(CURDATE()) - 1) DAY)", "INTERVAL 1 MONTH", "INTERVAL 1 MONTH"],
    ["db2", "CURRENT DATE - (DAY(CURRENT DATE) - 1) DAYS", "+ 1 MONTH", "- 1 MONTH"],
  ] as const)("%s 月条件从月初移动，跨年和月长变化由数据库处理", (dialect, month, next, previous) => {
    const thisMonth = find(dialect, "TIME_THIS_MONTH"), lastMonth = find(dialect, "TIME_LAST_MONTH");
    expect(thisMonth.insertText).toContain(month); expect(thisMonth.insertText).toContain(next);
    expect(lastMonth.insertText).toContain(month); expect(lastMonth.insertText).toContain(previous);
    expect(thisMonth.hint).toContain("本月月初至下月月初"); expect(lastMonth.hint).toContain("上月月初至本月月初");
    if (dialect === "mysql" || dialect === "mariadb") {
      expect(thisMonth.insertText).toContain(`DATE_ADD(${month}, INTERVAL 1 MONTH)`);
      expect(lastMonth.insertText).toContain(`DATE_SUB(${month}, INTERVAL 1 MONTH)`);
    }
  });

  it.each(dialects)("%s 在客户端跨年、大小月和闰年时不冻结日期", dialect => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-31T23:59:59Z")); const first = get(dialect);
    for (const now of ["2027-01-01T00:00:00Z", "2027-01-31T23:59:59Z", "2027-03-01T00:00:00Z", "2028-02-29T23:59:59Z"]) {
      vi.setSystemTime(new Date(now)); expect(get(dialect)).toEqual(first);
    }
    expect(JSON.stringify(first)).not.toMatch(/2026|2027|2028/);
  });
});

describe("实际日期类型和时区", () => {
  it("PostgreSQL DATE 与无时区、有时区 TIMESTAMP 保持各自类型", () => {
    expect(find("postgresql", "TIME_TODAY", "DATE").insertText).toContain("CAST(CURRENT_DATE AS DATE)");
    expect(find("postgresql", "TIME_TODAY", "timestamp without time zone").insertText).toBe("a.created >= CAST(CURRENT_DATE AS TIMESTAMP WITHOUT TIME ZONE) AND a.created < CAST(CURRENT_DATE + 1 AS TIMESTAMP WITHOUT TIME ZONE)$0");
    expect(find("postgresql", "TIME_TODAY", "timestamp(6) with time zone").insertText).toBe("a.created >= CAST(CURRENT_DATE AS TIMESTAMP(6) WITH TIME ZONE) AND a.created < CAST(CURRENT_DATE + 1 AS TIMESTAMP(6) WITH TIME ZONE)$0");
    expect(find("postgresql", "TIME_TODAY", "timestamptz").insertText).toContain("TIMESTAMP WITH TIME ZONE");
    expect(find("postgresql", "TIME_TODAY", "timestamp").insertText).toContain("TIMESTAMP WITHOUT TIME ZONE");
  });

  it("PostgreSQL 带时区自然日先移动日期，再分别转换为会话时区零点", () => {
    const sevenDays = find("postgresql", "TIME_LAST_7_DAYS", "TIMESTAMPTZ(3)");
    expect(sevenDays.insertText).toBe("a.created >= CAST(CURRENT_DATE - 6 AS TIMESTAMP(3) WITH TIME ZONE) AND a.created < CAST(CURRENT_DATE + 1 AS TIMESTAMP(3) WITH TIME ZONE)$0");
    const month = find("postgresql", "TIME_THIS_MONTH", "TIMESTAMPTZ");
    expect(month.insertText).toContain("CAST(DATE_TRUNC('month', CAST(CURRENT_DATE AS TIMESTAMP)) + INTERVAL '1 month' AS TIMESTAMP WITH TIME ZONE)");
    expect(month.hint).toContain("会话时区和当前事务日期");
  });

  it("Oracle 真实 DATE/TIMESTAMP 与时区类型使用相应边界", () => {
    expect(find("plsql", "TIME_TODAY", "TIMESTAMP(9)").insertText).toContain("CAST(TRUNC(CURRENT_DATE) AS TIMESTAMP(9))");
    expect(find("plsql", "TIME_TODAY", "TIMESTAMP(6) WITH TIME ZONE").insertText).toBe("a.created >= FROM_TZ(CAST(TRUNC(CURRENT_DATE) AS TIMESTAMP(6)), SESSIONTIMEZONE) AND a.created < FROM_TZ(CAST(TRUNC(CURRENT_DATE) + 1 AS TIMESTAMP(6)), SESSIONTIMEZONE)$0");
    expect(find("plsql", "TIME_TODAY", "TIMESTAMP WITH LOCAL TIME ZONE").insertText).toContain("CAST(FROM_TZ(CAST(TRUNC(CURRENT_DATE) AS TIMESTAMP), SESSIONTIMEZONE) AS TIMESTAMP WITH LOCAL TIME ZONE)");
    expect(find("plsql", "TIME_THIS_MONTH").insertText).not.toContain("ADD_MONTHS");
  });

  it.each(["DATETIME", "SMALLDATETIME", "DATETIME2", "DATETIME2(7)"])("SQL Server %s 使用真实类型，服务器日期语义明确", type => {
    expect(find("tsql", "TIME_TODAY", type).insertText).toContain(`AS ${type})`);
    expect(find("tsql", "TIME_TODAY", type).hint).toContain("数据库服务器当前日期和服务器本地时区");
  });

  it.each(["mysql", "mariadb"] as const)("%s TIMESTAMP 边界采用受支持的 DATETIME CAST", dialect => {
    expect(find(dialect, "TIME_TODAY", "TIMESTAMP(6)").insertText).toContain("CAST(CURDATE() AS DATETIME(6))");
    expect(find(dialect, "TIME_TODAY", "TIMESTAMP(6)").insertText).not.toContain("AS TIMESTAMP");
    expect(find(dialect, "TIME_TODAY", "DATETIME(3)").insertText).toContain("AS DATETIME(3)");
    expect(find(dialect, "TIME_TODAY", "TIMESTAMP(6)").hint).toContain("会话时区");
  });

  it("DB2 支持其真实时间戳精度", () => {
    expect(find("db2", "TIME_TODAY", "TIMESTAMP(12)").insertText).toBe("a.created >= CAST(CURRENT DATE AS TIMESTAMP(12)) AND a.created < CAST(CURRENT DATE + 1 DAY AS TIMESTAMP(12))$0");
  });

  it.each([
    ["tsql", "TIMESTAMP"], ["tsql", "TIMESTAMP(6)"], ["tsql", "ROWVERSION"], ["tsql", "DATETIMEOFFSET"], ["tsql", "DATETIMEOFFSET(7)"],
    ["tsql", "DATETIME2(8)"], ["tsql", "DATETIME(6)"], ["plsql", "TIMESTAMP(10)"], ["plsql", "TIMESTAMP WITHOUT TIME ZONE"],
    ["postgresql", "TIMESTAMP(7)"], ["postgresql", "TIMESTAMP WITH LOCAL TIME ZONE"], ["mysql", "TIMESTAMP(7)"],
    ["mysql", "TIMESTAMP WITH TIME ZONE"], ["db2", "TIMESTAMP(13)"], ["db2", "TIMESTAMP WITH TIME ZONE"],
    ["plsql", "DATE(10)"], ["plsql", "TIMESTAMP); DELETE FROM x; --"],
  ] as const)("%s 的无效或不能可靠确定日历语义的 %s 隐藏", (dialect, type) => {
    expect(get(dialect, type)).toEqual([]);
  });

  it.each(dialects)("%s 不根据 dbilldate 等 NC 字段名推断字符日期", dialect => {
    for (const type of ["CHAR(19)", "VARCHAR2(10)", "VARCHAR(19)", "TIME", "TIME WITH TIME ZONE", "TIMETZ", "NUMBER", "BOOLEAN", ""]) {
      expect(sqlTimePresets("a.dbilldate", type, dialect, true)).toEqual([]);
    }
  });

  it.each(["sqlite", "sql", "bigquery", "trino"] as const)("%s 没有可证明的类型/引擎语义时隐藏", dialect => {
    expect(get(dialect, "DATE")).toEqual([]); expect(get(dialect, "TIMESTAMP")).toEqual([]);
  });
});

describe("字段引用和格式", () => {
  it.each(dialects)("%s 保留已引用字段、别名与 snippet 转义两次", dialect => {
    const id = '"A"."Created$}"', escaped = snippetEscape(id);
    for (const item of sqlTimePresets(id, "DATE", dialect, true)) {
      expect(item.insertText.startsWith(`${escaped} >= `)).toBe(true);
      expect(item.suffix).toContain(`AND ${escaped} < `);
      expect(item.insertText.split(escaped)).toHaveLength(3);
      expect(item.insertText.endsWith("$0")).toBe(true);
    }
  });

  it("遵循已渲染的 MySQL/SQL Server 标识符引号", () => {
    expect(sqlTimePresets("a.`created``date`", "DATE", "mysql", true)[0].insertText).toContain("AND a.`created``date` < ");
    expect(sqlTimePresets("a.[created]]date]", "DATE", "tsql", true)[0].insertText).toContain("AND a.[created]]date] < ");
  });

  it.each(dialects)("%s 小写只影响 SQL 表达式，字段和字符串原文保留", dialect => {
    const items = sqlTimePresets('"A"."Created"', "DATE", dialect, false);
    for (const item of items) {
      expect(item.insertText).toContain('and "A"."Created" <');
      expect(item.insertText).not.toMatch(/CAST|CURRENT|DATEADD|CURDATE|DATE_SUB/);
    }
    if (dialect === "plsql") expect(items[1].insertText).toContain("trunc(current_date, 'MM')");
    if (dialect === "postgresql") expect(items[1].insertText).toContain("date_trunc('month', cast(current_date as timestamp))");
  });

  it.each(dialects)("%s 生成的四类条件可由当前方言格式化", dialect => {
    for (const item of get(dialect)) expect(() => format(`SELECT * FROM example_table a WHERE ${item.insertText.replace(/\$0$/, "")}`, { language: dialect })).not.toThrow();
  });

  it("类型空白、大小写与精度不会改变安全边界语义", () => {
    expect(get("postgresql", "  timestamp ( 6 ) with time zone  ")).toEqual(get("postgresql", "TIMESTAMP(6) WITH TIME ZONE"));
    expect(get("postgresql", "  timestamp (6)   with   time   zone  ")).toEqual(get("postgresql", "TIMESTAMP(6) WITH TIME ZONE"));
    expect(get("plsql", "TIMESTAMP(06)")).toEqual(get("plsql", "TIMESTAMP(6)"));
  });
});
