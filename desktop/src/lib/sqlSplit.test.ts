import { describe, expect, it } from "vitest";
import { isWrite, splitStatements, statementAt, stmtKind } from "./sqlSplit";

describe("splitStatements", () => {
  it("按分号切并去掉结尾分号", () => {
    const s = splitStatements("select 1 from dual;\nselect 2 from dual;");
    expect(s.map((x) => x.text)).toEqual(["select 1 from dual", "select 2 from dual"]);
    expect(s[1].startLine).toBe(2);
  });

  it("字符串与注释里的分号不算", () => {
    const s = splitStatements("select 'a;b' from dual -- x;y\n;\n/* ; */ select 2 from dual");
    expect(s).toHaveLength(2);
    expect(s[0].text).toBe("select 'a;b' from dual -- x;y");
    expect(s[1].text).toBe("/* ; */ select 2 from dual");
  });

  it("PL/SQL 块只认单独一行的斜杠", () => {
    const text = "begin\n  x := 1;\n  y := 2;\nend;\n/\nselect 1 from dual;";
    const s = splitStatements(text);
    expect(s).toHaveLength(2);
    expect(s[0].text).toBe("begin\n  x := 1;\n  y := 2;\nend;");
    expect(s[1].text).toBe("select 1 from dual");
  });

  it("create or replace procedure 也是块", () => {
    const s = splitStatements("create or replace procedure p as begin null; end;\n/");
    expect(s).toHaveLength(1);
    expect(s[0].text.endsWith("end;")).toBe(true);
  });

  it("没有结尾分号的最后一条也要", () => {
    expect(splitStatements("select 1 from dual;\n\nupdate t set a = 1").map((x) => x.text)).toEqual([
      "select 1 from dual",
      "update t set a = 1",
    ]);
  });

  it("只有注释和空白的段落忽略", () => {
    expect(splitStatements("-- 说明\n\n;  \n")).toEqual([]);
  });

  it("除号不是语句结束符", () => {
    expect(splitStatements("select a / b from t")).toHaveLength(1);
    expect(splitStatements("select a\n / b from t")).toHaveLength(1);
  });
});

describe("statementAt", () => {
  const text = "select 1 from dual;\n\nupdate t set a = 1;\n";

  it("光标在语句里取这一条", () => {
    expect(statementAt(text, 3)?.text).toBe("select 1 from dual");
    expect(statementAt(text, text.indexOf("set"))?.text).toBe("update t set a = 1");
  });

  it("光标在分号后面取上一条", () => {
    expect(statementAt(text, text.indexOf(";") + 1)?.text).toBe("select 1 from dual");
  });

  it("空白行取上方最近一条", () => {
    expect(statementAt(text, 20)?.text).toBe("select 1 from dual");
  });

  it("空文本返回 null", () => {
    expect(statementAt("  ", 0)).toBeNull();
  });
});

describe("语句类别", () => {
  it("区分查询、DML、DDL、PL/SQL", () => {
    expect(stmtKind("-- x\n with a as (select 1 from dual) select * from a")).toBe("query");
    expect(stmtKind("UPDATE t set a=1")).toBe("dml");
    expect(stmtKind("truncate table t")).toBe("ddl");
    expect(stmtKind("declare x number; begin null; end;")).toBe("plsql");
    expect(isWrite("select 1 from dual")).toBe(false);
    expect(isWrite("delete from t")).toBe(true);
  });
});
