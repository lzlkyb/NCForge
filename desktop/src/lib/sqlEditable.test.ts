import { describe, expect, it } from "vitest";
import { editableCellType, editableKeys, editableSource } from "./sqlEditable";

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
    expect(editableSource("with x as (select * from t) select * from x").reason).toContain("只有 SELECT");
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
