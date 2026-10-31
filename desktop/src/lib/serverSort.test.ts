import { describe, expect, it } from "vitest";
import { canServerSort, orderBySql, quoteIdent, serverSortLabel } from "./serverSort";

/**
 * A3：排序口径。本地排序只作用于已取的行，想让整表有序必须包一层 `order by` 重查。
 * 这里盯的是「哪些语句能包、包出来的 SQL 对不对」——包错了就是一次白跑或一个语法错。
 */

describe("quoteIdent", () => {
  it("全大写标识符不加引号（Oracle 未加引号一律按大写存）", () => {
    expect(quoteIdent("MATERIAL_NAME")).toBe("MATERIAL_NAME");
    expect(quoteIdent("A$1")).toBe("A$1");
  });

  it("小写别名必须加引号（`as total` 存的是 TOTAL，不加引号引用的就是另一列）", () => {
    expect(quoteIdent("total")).toBe('"total"');
    expect(quoteIdent("含 空格")).toBe('"含 空格"');
  });

  it("名字里的双引号要加倍转义", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe("canServerSort", () => {
  it("单条 SELECT / WITH 可以", () => {
    expect(canServerSort("select * from bd_material")).toBe(true);
    expect(canServerSort("with x as (select 1 from dual) select * from x")).toBe(true);
    expect(canServerSort("  select 1 from dual;  ")).toBe(true);
  });

  it("DML / PL/SQL / 多语句不行", () => {
    expect(canServerSort("update bd_material set name = 'x'")).toBe(false);
    expect(canServerSort("begin null; end;")).toBe(false);
    expect(canServerSort("select 1 from dual; select 2 from dual")).toBe(false);
  });

  it("for update 不行（子查询里带 for update 是语法错）", () => {
    expect(canServerSort("select * from bd_material for update")).toBe(false);
  });
});

describe("orderBySql", () => {
  it("包一层子查询，而不是往末尾追加 order by", () => {
    const out = orderBySql("select id, name from bd_material", "NAME", "desc");
    expect(out).toBe("select * from (\nselect id, name from bd_material\n) order by NAME desc");
  });

  it("原 SQL 已有 order by 也照样能包（不会出现两个 order by）", () => {
    const out = orderBySql("select * from t order by id", "NAME", "asc");
    expect(out?.match(/order by/gi)).toHaveLength(2);
    expect(out?.endsWith(") order by NAME asc")).toBe(true);
  });

  it("末尾分号会被去掉（留着会变成 ORA-00911）", () => {
    expect(orderBySql("select 1 from dual;", "DUMMY", "asc")).not.toContain(";");
  });

  it("不能重排时返回 null（调用方据此禁用菜单项）", () => {
    expect(orderBySql("delete from t", "ID", "asc")).toBeNull();
    expect(orderBySql("select * from t for update", "ID", "asc")).toBeNull();
  });

  it("小写别名按原样加引号，才不会引到不存在的列", () => {
    const out = orderBySql("select id as total from t", "total", "asc");
    expect(out).toContain('order by "total" asc');
  });

  it("菜单文案说清「作用全表」", () => {
    expect(serverSortLabel("NAME", "asc")).toContain("重查");
    expect(serverSortLabel("NAME", "desc")).toContain("降序");
  });
});
