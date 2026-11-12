import { describe, expect, it } from "vitest";
import { locateIdent, oraCodeOf, oraHint } from "./oraErrorHint";

describe("ORA 错误定位", () => {
  it("取 ORA 号", () => {
    expect(oraCodeOf("ORA-00904: \"X\": invalid identifier")).toBe("ORA-00904");
    expect(oraCodeOf("java.sql.SQLException: ORA-00001: unique constraint")).toBe("ORA-00001");
    expect(oraCodeOf("connection reset")).toBeNull();
  });

  it("ORA-00904 定位到标识符所在行列", () => {
    const sql = "select id,\n       bd_xxx\n  from bd_material";
    const hint = oraHint('ORA-00904: "BD_XXX": invalid identifier', sql)!;
    expect(hint.location).toMatchObject({ ident: "BD_XXX", line: 2, column: 8, occurrences: 1 });
    expect(hint.note).toContain("标识符");
  });

  it("同名多处出现时报出总数", () => {
    const sql = "select bd_xxx from t where bd_xxx = 1";
    const hint = oraHint('ORA-00904: "BD_XXX": 标识符无效', sql)!;
    expect(hint.location?.occurrences).toBe(2);
  });

  it("语句里找不到这个名字就不给位置（不猜）", () => {
    const hint = oraHint('ORA-00904: "OTHER": invalid identifier', "select id from t")!;
    expect(hint.location).toBeUndefined();
    expect(hint.note).toBeTruthy();
  });

  it("汉字标识符也认", () => {
    const sql = "select 数量 from t";
    expect(locateIdent(sql, "数量")).toMatchObject({ line: 1, column: 8 });
  });

  it("字符串与注释里的同名文本不算位置（不能被指到错的代码行）", () => {
    const sql = "select 'bd_xxx' as note, -- bd_xxx\n       bd_xxx\n  from t";
    // 注释在第 1 行行尾、字符串也在第 1 行；真正出错的标识符在第 2 行
    expect(locateIdent(sql, "BD_XXX")).toMatchObject({ line: 2, column: 8, occurrences: 1 });
  });

  it("带双引号的标识符按名字匹配", () => {
    expect(locateIdent('select 1 from t where "BD_XXX" = 2', "BD_XXX")).toMatchObject({ line: 1, occurrences: 1 });
  });

  it("没有位置线索的错误只给一句解释", () => {
    expect(oraHint("ORA-01722: invalid number", "select 1")?.note).toContain("数字");
    expect(oraHint("ORA-01438: value larger than specified precision", "")?.note).toContain("精度");
  });

  it("不认识的错误不返回内容", () => {
    expect(oraHint("ORA-04068: existing state of packages has been discarded", "begin p; end;")).toBeNull();
  });
});
