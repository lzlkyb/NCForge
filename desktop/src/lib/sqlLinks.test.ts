import { describe, expect, it } from "vitest";
import { maskSql, tableLinks } from "./sqlLinks";

/** 命中的词按出现顺序返回（原文切片，用来确认范围算对了）。 */
const words = (sql: string) => tableLinks(sql).map((l) => sql.slice(l.start, l.end));
/** 命中的词 → 真正要打开的表。 */
const targets = (sql: string) => tableLinks(sql).map((l) => l.table);

describe("maskSql", () => {
  it("长度不变，换行留着", () => {
    const sql = "select '--x' -- from t\n/* a\nb */ from u";
    const masked = maskSql(sql);
    expect(masked.length).toBe(sql.length);
    expect(masked.split("\n").length).toBe(sql.split("\n").length);
    expect(masked).not.toContain("--x");
    expect(masked).not.toContain("from t");
    expect(masked.slice(-6)).toBe("from u");
  });

  it("转义引号不算结束", () => {
    expect(maskSql("'it''s' from t").slice(-6)).toBe("from t");
  });
});

describe("tableLinks", () => {
  it("from 后面的表名", () => {
    expect(words("select * from bd_material where code = '1'")).toEqual(["bd_material"]);
    expect(targets("select * from bd_material")).toEqual(["bd_material"]);
  });

  it("join / update / insert into / create table", () => {
    expect(words("select 1 from a left join ic_saleout_b b on b.id = a.id")).toEqual(["a", "ic_saleout_b", "b"]);
    expect(targets("update bd_material set code = 1")).toEqual(["bd_material"]);
    expect(targets("insert into bd_material (code) values ('x')")).toEqual(["bd_material"]);
    expect(targets("create table tmp_x (a number)")).toEqual(["tmp_x"]);
  });

  it("别名点自己也跳回表，但别名限定名与字段名不跳", () => {
    expect(targets("select m.code from bd_material m")).toEqual(["bd_material", "bd_material"]);
    expect(words("select m.code from bd_material m")).toEqual(["bd_material", "m"]);
    // 字段名和函数名都不是表
    expect(words("select nvl(code, 0) as c from bd_material")).toEqual(["bd_material"]);
  });

  it("注释与字符串里的词不跳", () => {
    expect(words("-- from bd_material\nselect 1 from dual")).toEqual(["dual"]);
    expect(words("select 'from bd_material' from aier.org_orgs o")).toEqual(["org_orgs", "o"]);
  });

  it("schema 前缀本身不跳，后一段跳", () => {
    expect(words("select * from sys.bd_material")).toEqual(["bd_material"]);
    expect(targets("select * from sys.bd_material")).toEqual(["bd_material"]);
  });

  it("位置就是那个词的位置", () => {
    const sql = "select * from bd_material";
    const [link] = tableLinks(sql);
    expect(sql.slice(link.start, link.end)).toBe("bd_material");
    expect(link.start).toBe(14);
  });
});
