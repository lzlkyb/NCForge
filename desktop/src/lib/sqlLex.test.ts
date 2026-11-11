import { describe, expect, it } from "vitest";
import { scanSql } from "./sqlLex";
describe("SQL词法识别", () => {
  it.each(["q'[it's from fake x]'", "nq'{it's select}'", "q'!it's where!'", "q'<it's and>'"])("Oracle特殊字符串 %s", text => {
    expect(scanSql(text + " select", "plsql").tokens.filter(t => t.kind !== "space").map(t => [t.text, t.kind])).toEqual([[text, "string"], ["select", "keyword"]]);
  });
  it("跨行和未完成字符串保留状态", () => {
    const first = scanSql("select q'[it's", "plsql");
    expect(first.state.mode).toBe("quote");
    const second = scanSql("from fake]' from dual", "plsql", first.state);
    expect(second.tokens[0]).toMatchObject({ text: "from fake]'", kind: "string" });
    expect(second.state.mode).toBe("plain");
  });
  it("提示、普通注释和绑定变量分开，PG类型转换不会成为绑定变量", () => {
    expect(scanSql("/*+ index(t) */ -- select\n:pk :1", "plsql").tokens.filter(t => t.kind !== "space").map(t => t.kind)).toEqual(["hint", "comment", "parameter", "parameter"]);
    expect(scanSql("$1::int $$it's select$$", "postgresql").tokens.filter(t => t.kind !== "space").map(t => t.kind)).toEqual(["parameter", "operator", "type", "string"]);
  });
  it("嵌套注释仅按支持的方言处理", () => {
    expect(scanSql("/* a /* b */ c */ select", "postgresql").tokens[0].text).toBe("/* a /* b */ c */");
    expect(scanSql("/* a /* b */ c */ select", "plsql").tokens[0].text).toBe("/* a /* b */");
  });
  it("引用标识符不被识别为关键字，Oracle分页与层次查询高亮", () => {
    const tokens = scanSql('SELECT "where", rownum, level FROM dual CONNECT BY PRIOR id = :parent', "plsql").tokens;
    expect(tokens.find(t => t.text === '"where"')?.kind).toBe("quoted");
    expect(tokens.filter(t => ["rownum", "level", "CONNECT", "PRIOR"].includes(t.text)).every(t => t.kind === "keyword")).toBe(true);
  });
  it("注释、字符串、HTML文本保持原始内容", () => {
    const sql = "select '<script>alert(1)</script>', '-- /*' from t -- end\n";
    expect(scanSql(sql).tokens.map(t => t.text).join("")).toBe(sql);
  });
});
