/**
 * 注释口径边界回归（原 Q-3/Q-6，2026-11-19 复现结案）。
 *
 * 复现结论：Q-3/Q-6 的原案（前导注释漏判 DML/危险、lexer 不跳注释）**不成立**——
 * `stripLeading` 剥前导注释、`tokenize`/`scanSql` 都跳注释、注释里的关键字不参与判定。
 * 真实分叉只有一处：MySQL `#` 行注释原先只有 `scanSql` 认，`stripLeading`/
 * `splitStatements`/`tokenize` 不认，导致 `# 注释` 引导的语句类别判错、注释里的
 * 分号误切语句。已在三处补齐（只认词首 `#`，Oracle 标识符里的 `#` 不受影响）。
 * 本文件把两套口径的边界钉住：前导/中间/尾部注释、hint、未闭合、嵌套、`#`、
 * 以及「Oracle 标识符含 #」反例。
 */
import { describe, expect, it } from "vitest";
import { isWrite, stmtKind, splitStatements, stripLeading } from "./sqlSplit";
import { editableSource } from "./sqlEditable";
import { dangerOf } from "./sqlDanger";
import { tokenize } from "./sqlTokens";
import { scanSql } from "./sqlLex";

describe("注释口径边界（Q-3/Q-6 结案回归）", () => {
  it("Q-3 原案：前导块注释的 DELETE", () => {
    expect(stmtKind("/* c */ delete from t")).toBe("dml");
    expect(isWrite("/* c */ delete from t")).toBe(true);
    expect(stmtKind("-- c\ndelete from t")).toBe("dml");
    expect(dangerOf("/* c */ delete from t")?.kind).toBe("delete-all");
  });
  it("hint 当前导注释：SELECT 带提示", () => {
    expect(stmtKind("/*+ INDEX(t idx) */ select * from t")).toBe("query");
    expect(isWrite("/*+ INDEX(t idx) */ select * from t")).toBe(false);
  });
  it("注释在语句中间/尾部", () => {
    expect(stmtKind("select /* c */ * from t")).toBe("query");
    expect(editableSource("select code from bd_material -- 注释").table).toBe("bd_material");
    expect(editableSource("/* 头 */ select code from bd_material").table).toBe("bd_material");
    expect(editableSource("select code from /* 中间 */ bd_material").table).toBe("bd_material");
  });
  it("注释里的关键字不参与判定", () => {
    expect(editableSource("select code from bd_material -- join x on 1=1").table).toBe("bd_material");
    expect(editableSource("select code from bd_material /* union select 1 */").table).toBe("bd_material");
    expect(dangerOf("update t set x = 1 /* where id = 1 */")?.kind).toBe("update-all");
    expect(dangerOf("update t set x = 1 -- where id = 1")?.kind).toBe("update-all");
  });
  it("MySQL # 注释：三处口径与 scanSql 一致", () => {
    expect(stmtKind("# c\ndelete from t")).toBe("dml");
    expect(tokenize("# c\nselect code from t").filter(t => t.kind === "word").map(t => t.text)).toEqual(["select", "code", "from", "t"]);
    // # 注释里的分号不是语句结束
    expect(splitStatements("# a;b\ndelete from t;").map(s => stmtKind(s.text))).toEqual(["dml"]);
    expect(editableSource("# 头注释\nselect code from bd_material").table).toBe("bd_material");
  });
  it("反例：Oracle 标识符里的 # 不是注释", () => {
    expect(splitStatements("select a# from t#;").map(s => s.text)).toEqual(["select a# from t#"]);
    expect(editableSource("select a# from t#").table).toBe("t#");
    expect(tokenize("select a# from t#").filter(t => t.kind === "word").map(t => t.text)).toEqual(["select", "a#", "from", "t#"]);
    expect(stmtKind("select a# from t#")).toBe("query");
  });
  it("# 紧贴分号/逗号/数字也是注释（2026-11-19 审查补）", () => {
    // ;#comment 换行后是下一条；注释里的分号不切
    expect(splitStatements("select 1 from dual;# 注释;不是语句\ndelete from t;").map(s => stmtKind(s.text))).toEqual(["query", "dml"]);
    expect(splitStatements("select a,# c;d\nb from t").map(s => s.text)).toEqual(["select a,# c;d\nb from t"]);
    expect(tokenize("select 1# c;d\nfrom t").filter(t => t.kind === "word").map(t => t.text)).toEqual(["select", "from", "t"]);
    // 反例：标识符字符后的 # 仍不是注释
    expect(splitStatements("select a#b from t;").map(s => s.text)).toEqual(["select a#b from t"]);
  });
  it("嵌套块注释（PostgreSQL 语义，scanSql 认、tokenize/stripLeading 不认）", () => {
    const nested = "/* outer /* inner */ select code from t";
    expect(scanSql(nested, "postgresql").tokens.filter(t => t.kind === "comment")).toHaveLength(1);
    expect(stmtKind(nested)).toBe("query");
    expect(tokenize(nested).filter(t => t.kind === "word").map(t => t.text)).toEqual(["select", "code", "from", "t"]);
  });
  it("注释-only 语句与切分", () => {
    expect(splitStatements("-- 只有注释\n").length).toBe(0);
    expect(splitStatements("/* 只有注释 */").length).toBe(0);
    expect(splitStatements("select 1 from dual; -- 尾注释\ndelete from t;").map(s => stmtKind(s.text))).toEqual(["query", "dml"]);
  });
  it("stripLeading 未闭合注释", () => {
    expect(stripLeading("/* 没闭合 delete from t")).toBe("");
    expect(isWrite("/* 没闭合 delete from t")).toBe(true);
  });
  it("长前导注释的 PL/SQL 块（120 字符判定窗口）", () => {
    const long = "-- " + "说明".repeat(80) + "\nbegin\n  null;\nend;";
    const stmts = splitStatements(long);
    expect(stmts).toHaveLength(1);
    expect(stmtKind(stmts[0].text)).toBe("plsql");
    const block = "/* " + "x".repeat(200) + " */\nbegin\n  null;\nend;";
    expect(splitStatements(block)).toHaveLength(1);
  });
  it("hint 引导的 DML 与注释-only 的 isWrite 口径", () => {
    expect(stmtKind("/*+ FULL(t) */ delete from t")).toBe("dml");
    expect(isWrite("-- 只有注释")).toBe(true);
  });
});