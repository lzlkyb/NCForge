import { expect, it } from "vitest";
import { analyzeSql } from "./sqlScope";
import { scopedTableLinks } from "./sqlScopeLinks";
const links = (sql: string) => scopedTableLinks(analyzeSql(sql, "plsql")).map(link => [sql.slice(link.start, link.end), link.table]);
it("物理表和声明别名保留DDL跳转，限定字段不会成为链接", () => {
  expect(links("select m.code from bd_material m")).toEqual([["bd_material", "bd_material"], ["m", "bd_material"]]);
  expect(links("insert into bd_material (code) values ('x')")).toEqual([["bd_material", "bd_material"]]);
  expect(links("create table tmp_x (a number)")).toEqual([["tmp_x", "tmp_x"]]);
  expect(links("create table sys.tmp_x (a number)")).toEqual([["tmp_x", "tmp_x"]]);
});
it("同名别名按内外层跳转，重复别名不跳，CTE不打开同名物理表", () => {
  expect(links("select * from outer_table e where exists (select * from inner_table e)")).toEqual([["outer_table", "outer_table"], ["e", "outer_table"], ["inner_table", "inner_table"], ["e", "inner_table"]]);
  expect(links("select * from a e join b e on 1=1")).toEqual([["a", "a"], ["b", "b"]]);
  expect(links("with x as (select id from a) select x.id from x")).toEqual([["a", "a"]]);
});
it("Oracle字符串与提示不会出现伪表名链接", () => {
  expect(links("select /*+ index(fake) */ q'[it's from fake f]' from real_table r")).toEqual([["real_table", "real_table"], ["r", "real_table"]]);
});
