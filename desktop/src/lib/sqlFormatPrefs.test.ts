// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_SQL_FORMAT, formatOptionsOf, getSqlFormatPrefs, setSqlFormatPrefs } from "./sqlFormatPrefs";

describe("SQL 格式化偏好", () => {
  it("默认值沿用 sql-formatter 的保守选项", () => {
    expect(getSqlFormatPrefs()).toEqual(DEFAULT_SQL_FORMAT);
    expect(DEFAULT_SQL_FORMAT).toMatchObject({ keywordCase: "preserve", indentStyle: "standard", tabWidth: 2, dialect: "auto" });
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
      keywordCase: "preserve",
      indentStyle: "standard",
      tabWidth: 2,
      expressionWidth: 50,
      linesBetweenQueries: 1,
      logicalOperatorNewline: "before",
    });
  });
});
