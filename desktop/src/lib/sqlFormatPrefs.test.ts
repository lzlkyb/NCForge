// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SQL_FORMAT, formatOptionsOf, getSqlFormatPrefs, setSqlFormatPrefs } from "./sqlFormatPrefs";

afterEach(() => { setSqlFormatPrefs(DEFAULT_SQL_FORMAT); vi.restoreAllMocks(); });

describe("SQL 格式化偏好", () => {
  it("阅读优先默认120列，保留大小写和既有缩进习惯", () => {
    expect(getSqlFormatPrefs()).toEqual(DEFAULT_SQL_FORMAT);
    expect(DEFAULT_SQL_FORMAT).toMatchObject({ layout: "reading", lineWidth: 120, keywordCase: "preserve", indentStyle: "standard", tabWidth: 2, dialect: "auto" });
  });

  it("保存后本机持久化并可同步读取", () => {
    expect(setSqlFormatPrefs({ tabWidth: 4, keywordCase: "upper" })).toBe(true);
    expect(getSqlFormatPrefs()).toMatchObject({ tabWidth: 4, keywordCase: "upper" });
    const raw = JSON.parse(localStorage.getItem("ncforge-sql-format-prefs")!);
    expect(raw).toMatchObject({ tabWidth: 4, keywordCase: "upper" });
  });

  it("越界与未知值回落默认，不整体失效", () => {
    setSqlFormatPrefs({ tabWidth: 99, expressionWidth: 0, dialect: "weird" as never, indentStyle: "x" as never });
    expect(getSqlFormatPrefs()).toMatchObject({
      tabWidth: DEFAULT_SQL_FORMAT.tabWidth,
      expressionWidth: DEFAULT_SQL_FORMAT.expressionWidth,
      dialect: "auto",
      indentStyle: "standard",
    });
  });

  it("formatOptionsOf 只透出排版选项", () => {
    expect(formatOptionsOf(DEFAULT_SQL_FORMAT)).toEqual({
      layout: "reading",
      lineWidth: 120,
      keywordCase: "preserve",
      indentStyle: "standard",
      tabWidth: 2,
      expressionWidth: 50,
      linesBetweenQueries: 1,
      logicalOperatorNewline: "before",
    });
  });

  it("新增布局字段缺失时迁移为阅读优先，既有字段按原值保留", async () => {
    localStorage.setItem("ncforge-sql-format-prefs", JSON.stringify({ keywordCase: "upper", tabWidth: 4, indentStyle: "tabularLeft", dialect: "plsql", expressionWidth: 70 }));
    vi.resetModules();
    const reloaded = await import("./sqlFormatPrefs");
    expect(reloaded.getSqlFormatPrefs()).toMatchObject({ layout: "reading", lineWidth: 120, keywordCase: "upper", tabWidth: 4, indentStyle: "tabularLeft", dialect: "plsql", expressionWidth: 70 });
  });

  it("布局与行宽越界回落，保存失败允许同值重试", () => {
    setSqlFormatPrefs({ layout: "invalid" as never, lineWidth: 500 });
    expect(getSqlFormatPrefs()).toMatchObject({ layout: "reading", lineWidth: 120 });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("只读"); });
    expect(setSqlFormatPrefs({ layout: "expanded", lineWidth: 100 })).toBe(false);
    expect(getSqlFormatPrefs()).toMatchObject({ layout: "expanded", lineWidth: 100 });
    write.mockRestore();
    expect(setSqlFormatPrefs({ layout: "expanded", lineWidth: 100 })).toBe(true);
    expect(JSON.parse(localStorage.getItem("ncforge-sql-format-prefs")!)).toMatchObject({ layout: "expanded", lineWidth: 100 });
  });
});
