import { describe, expect, it } from "vitest";
import { editableCellType, editableCustomKeys, editableIdentity, editableKeys, editableSource } from "./sqlEditable";
import { analyzeSql } from "./sqlSource";

describe("editableSource", () => {
  it("最简单的单表查询可以改", () => {
    expect(editableSource("select * from bd_material").table).toBe("bd_material");
  });
  it("带 schema、条件与排序也能认出来", () => {
    expect(editableSource("select code, name from aier.bd_material where dr = 0 order by code").table).toBe("aier.bd_material");
  });
  it("注释与结尾分号不影响判断", () => {
    expect(editableSource("-- 查物料\nselect * from bd_material;").table).toBe("bd_material");
  });
  it("多表关联拒绝", () => {
    expect(editableSource("select * from a left join b on a.id = b.id").reason).toContain("多表关联");
  });
  it("聚合拒绝", () => {
    expect(editableSource("select count(*) from bd_material").reason).toContain("聚合");
  });
  it("去重、分组、集合运算、子查询、窗口函数都拒绝", () => {
    expect(editableSource("select distinct code from t").table).toBeNull();
    expect(editableSource("select code from t group by code").table).toBeNull();
    expect(editableSource("select * from a union select * from b").table).toBeNull();
    expect(editableSource("select * from (select * from t) x").table).toBeNull();
    expect(editableSource("select row_number() over (order by code) from t").table).toBeNull();
  });
  it("不是 SELECT 就拒绝", () => {
    expect(editableSource("update t set a = 1").reason).toContain("只有 SELECT");
    expect(editableSource("begin null; end;").table).toBeNull();
  });
  it("多条语句拒绝", () => {
    expect(editableSource("select * from a; select * from b").reason).toContain("单条");
  });
});

describe("editableKeys", () => {
  it("结果里带齐主键才放行", () => {
    expect(editableKeys([{ name: "ID" }, { name: "CODE" }], ["id"])).toEqual({ keys: ["ID"], reason: "" });
  });
  it("没有主键不能改", () => {
    expect(editableKeys([{ name: "CODE" }], []).reason).toContain("没有主键");
  });
  it("结果缺主键列不能改", () => {
    expect(editableKeys([{ name: "CODE" }], ["ID"]).reason).toContain("ID");
  });
});

describe("editableCellType", () => {
  it("常见可写类型放行", () => {
    for (const type of ["VARCHAR2(40)", "NUMBER(28,8)", "DATE", "TIMESTAMP(6)", "CLOB"]) {
      expect(editableCellType(type)).toBe(true);
    }
  });
  it("二进制与带时区的时间戳不放行", () => {
    expect(editableCellType("BLOB")).toBe(false);
    expect(editableCellType("RAW(16)")).toBe(false);
    expect(editableCellType("TIMESTAMP(3) WITH TIME ZONE")).toBe(false);
  });
});

describe("analyzeSql", () => {
  it("字符串与注释里的关键字不参与判断", () => {
    expect(analyzeSql("select 'from x; y' as code from bd_material").table).toBe("bd_material");
    expect(analyzeSql("select * from bd_material /* from other; */ where memo = 'from x'").table).toBe("bd_material");
    expect(analyzeSql("-- from x\nselect * from bd_material").table).toBe("bd_material");
  });
  it("选择列表里的标量子查询不会把基表认成子查询里的表", () => {
    const q = analyzeSql("select (select count(*) from b where b.id = a.id) n, a.code from a");
    expect(q.table).toBe("a");
    expect(q.mapping.get("N")).toBeNull();
    expect(q.mapping.get("CODE")).toBe("code");
  });
  it("逗号连接、旧式外连接、表函数、引号表名都拒绝", () => {
    expect(analyzeSql("select * from a, b").code).toBe("join");
    expect(analyzeSql("select * from a where a.id = b.id (+)").code).toBe("join");
    expect(analyzeSql("select * from my_func(1)").code).toBe("table-function");
    expect(analyzeSql('select * from "lower_table"').code).toBe("table-name");
  });
  it("没有 FROM 与分区/SAMPLE 写法不放行", () => {
    expect(analyzeSql("select 1 from dual where 1 = 1").table).toBe("dual");
    expect(analyzeSql("select 1").code).toBe("no-table");
    expect(analyzeSql("select * from t partition (p1)").code).toBe("table-function");
  });
  it("输出别名映射回表列，rowid 单独标记", () => {
    const alias = analyzeSql("select code as c, t.name \"名称\" from t t");
    expect(alias.mapping.get("C")).toBe("code");
    expect(alias.mapping.get("名称")).toBe("name");
    expect(alias.alias).toBe("t");
    const rid = analyzeSql("select rowid, t.* from bd_material t");
    expect(rid.rowid).toBe(true);
    expect(rid.star).toBe(true);
  });
  it("简单 CTE 按内层基表放行，递归 CTE 拒绝", () => {
    const q = analyzeSql("with x as (select * from bd_material) select * from x");
    expect(q.table).toBe("bd_material");
    expect(analyzeSql("with recursive x as (select * from t) select * from x").code).toBe("recursive-cte");
  });
});

describe("editableIdentity", () => {
  const cols = [{ name: "编码" }, { name: "NAME" }];
  const map = (i: number) => (i === 0 ? "CODE" : "NAME");

  it("主键经别名映射到结果列", () => {
    expect(editableIdentity(cols, ["CODE"], map)).toMatchObject({ keys: ["CODE"], keyCols: [0], kind: "pk", reason: "" });
  });
  it("缺主键列 / 多列对应同一主键都拒绝", () => {
    expect(editableIdentity(cols, ["CODE", "ID"], map).missing).toEqual(["ID"]);
    expect(editableIdentity([{ name: "A" }, { name: "B" }], ["CODE"], () => "CODE").reason).toContain("多列对应主键");
  });
  it("ROWID 优先，不需要主键", () => {
    expect(editableIdentity(cols, [], map, 1)).toMatchObject({ kind: "rowid", reason: "" });
  });
});

describe("editableCustomKeys", () => {
  it("手动指定且能对上表列的定位列放行", () => {
    expect(editableCustomKeys([{ name: "编码" }], ["编码"], i => (i === 0 ? "CODE" : null)))
      .toMatchObject({ keys: ["编码"], keyCols: [0], kind: "custom", reason: "" });
  });
  it("表达式列不能当定位列", () => {
    expect(editableCustomKeys([{ name: "N" }], ["N"], () => null).reason).toContain("不能写回表列");
  });
});
