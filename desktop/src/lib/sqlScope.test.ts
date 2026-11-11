import { describe, expect, it } from "vitest";
import { analyzeSql, resolveSqlQualifier, sqlCompletionAt, sqlSourcesAt } from "./sqlScope";
const resolve = (sql: string, at: string, name: string) => {
  const analysis = analyzeSql(sql, "plsql"), offset = sql.indexOf(at);
  return resolveSqlQualifier(analysis, offset, name, analysis.tokens.find(t => t.start === offset)?.text);
};
describe("SQL查询作用域", () => {
  it("内外层同名别名不会串表，相关子查询能找到外层别名", () => {
    const sql = "select e.outer_id from outer_table e where exists (select e.inner_id from inner_table e where e.x = 1) and e.y = 2";
    expect(resolve(sql, "e.outer_id", "e")?.table).toBe("outer_table");
    expect(resolve(sql, "e.inner_id", "e")?.table).toBe("inner_table");
    expect(resolve(sql, "e.y", "e")?.table).toBe("outer_table");
    expect(resolve("select o.id from outer_table o where exists (select i.id from inner_table i where i.id = o.id)", "i.id =", "o")?.table).toBe("outer_table");
  });
  it("同层重复别名不随便选择一张表", () => {
    expect(resolve("select e.id from a e join b e on e.id = e.id", "e.id", "e")).toBeUndefined();
  });
  it("Oracle 折叠未引用别名，区分引用小写并拒绝语义重复的引用大写", () => {
    const sql = 'select m.id, "m".id from a m join b "m" on 1=1';
    expect(resolve(sql, "m.id", "m")?.table).toBe("a");
    expect(resolve(sql, '"m".id', "m")?.table).toBe("b");
    expect(resolve('select m.id from a m join b "M" on 1=1', "m.id", "m")).toBeUndefined();
    const pg = 'select m.id, "M".id from a m join b "M" on 1=1', analysis = analyzeSql(pg, "postgresql");
    expect(resolveSqlQualifier(analysis, pg.indexOf("m.id"), "m", "m")?.table).toBe("a");
    expect(resolveSqlQualifier(analysis, pg.indexOf('"M".id'), "M", '"M"')?.table).toBe("b");
  });
  it("CTE与派生表只给可确定的输出列", () => {
    expect(resolve("with x as (select a.id, a.name display_name from physical a) select x.id from x", "x.id from", "x")?.columns).toEqual(["id", "display_name"]);
    expect(resolve("select d.id from (select id, count(*) as total, * from physical) d", "d.id", "d")?.columns).toEqual(["id", "total"]);
    expect(resolve("select d.total from (select a.id + b.id, a.id + b.id as total, case when a.id = 1 then 1 else 0 end flag from a join b on 1=1) d", "d.total", "d")?.columns).toEqual(["total", "flag"]);
  });
  it("CTE 引用采用方言折叠，Oracle 引用小写不会遮蔽物理大写表", () => {
    expect(resolve('with "x" as (select id from b) select x.id from x', "x.id", "x")?.table).toBe("x");
    expect(resolve('with "X" as (select id from b) select x.id from x', "x.id", "x")?.table).toBeUndefined();
    expect(resolve('with "X" as (select id from b) select x.id from x', "x.id", "x")?.columns).toEqual(["id"]);
  });
  it("过大脚本保留词法高亮并关闭语义猜测", () => {
    const sql = "select a.id from physical a;".repeat(513), analysis = analyzeSql(sql);
    expect(analysis.tokens.some(token => token.kind === "keyword")).toBe(true); expect(analysis.scopes).toEqual([]); expect(analysis.roles.size).toBe(0);
  });
  it("CTE显式列名优先，后面的CTE可引用前面，脚本之间隔离", () => {
    const sql = "with x(code, title) as (select id, name from physical), y as (select code from x) select y.code from y";
    expect(resolve(sql, "code from x", "x")?.columns).toEqual(["code", "title"]);
    expect(resolve(sql, "y.code", "y")?.columns).toEqual(["code"]);
    expect(resolve(sql + "; select x.id from x", "x.id", "x")?.table).toBe("x");
  });
  it("CTE不能看到后声明的CTE，派生表不能误用外层别名", () => {
    expect(resolve("with x as (select * from y), y as (select id from b) select * from x", "* from y", "y")?.table).toBe("y");
    expect(resolve("select o.id from a o join (select o.id from b) d on 1=1", "o.id from b", "o")).toBeUndefined();
  });
  it("UNION分支和字符串注释隔离，外层字段不读取内层物理表", () => {
    const sql = "select a.id from first_table a union all select a.id from second_table a";
    expect(resolveSqlQualifier(analyzeSql(sql), sql.lastIndexOf("a.id"), "a")?.table).toBe("second_table");
    const nested = "select d.id, q'[it's from fake f]' from (select id from real_table r) d -- from fake2 z";
    expect(sqlSourcesAt(analyzeSql(nested, "plsql"), 7).map(s => s.table)).toEqual([undefined]);
  });
  it("引用名字区分大小写，并保留中文字段", () => {
    expect(resolve('select "Mixed"."名称" from "Table" "Mixed"', '"Mixed".', "Mixed")?.table).toBe("Table");
    expect(resolve('select "Mixed"."名称" from "Table" "Mixed"', '"Mixed".', "mixed")).toBeUndefined();
    expect(resolve("with x as (select title from a) select q.id from app.x q", "q.id", "q")).toMatchObject({ table: "x" });
    expect(resolve('with x as (select title from a) select q.id from "schema".x q', "q.id", "q")).toMatchObject({ table: "x" });
  });
  it("字段表和别名有语义分类，未知限定名不误标", () => {
    const sql = "select a.id, nvl(a.name, :name), missing.id from physical a";
    const a = analyzeSql(sql, "plsql");
    const role = (text: string) => a.roles.get(a.tokens.findIndex(t => t.text === text));
    expect(role("a")).toBe("alias"); expect(role("id")).toBe("column"); expect(role("nvl")).toBe("function"); expect(role("physical")).toBe("table"); expect(role("missing")).toBeUndefined();
  });
  it("输入未完成时仍可补全，字符串注释内不补全", () => {
    for (const sql of ["select a.", "select a.na", 'select "Mixed".']) expect(sqlCompletionAt(analyzeSql(sql), sql.length).kind).toBe("column");
    for (const sql of ["select q'[from t a. select", "select 1 -- a.", "select :param"]) expect(sqlCompletionAt(analyzeSql(sql, "plsql"), sql.length).kind).toBe("none");
    const sql = "select a.id from a x, "; expect(sqlCompletionAt(analyzeSql(sql), sql.length).kind).toBe("table");
  });
});
