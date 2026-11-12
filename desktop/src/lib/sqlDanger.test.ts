import { describe, expect, it } from "vitest";
import { dangerOf, dangerousStatements } from "./sqlDanger";

describe("危险语句识别", () => {
  it("没有 WHERE 的 UPDATE / DELETE 要拦", () => {
    expect(dangerOf("update bd_material set name = 'x'")).toMatchObject({
      kind: "update-all", table: "bd_material", advisory: false,
      countSql: "select count(*) from bd_material",
    });
    expect(dangerOf("delete from bd_material")).toMatchObject({
      kind: "delete-all", table: "bd_material", advisory: false,
      countSql: "select count(*) from bd_material",
    });
  });

  it("WHERE 1=1 等同于没有 WHERE", () => {
    expect(dangerOf("delete from t where 1 = 1")).toMatchObject({ kind: "delete-all" });
    expect(dangerOf("delete from t where (1=1);")).toMatchObject({ kind: "delete-all" });
    expect(dangerOf("update t set a = 1 where 1=1")).toMatchObject({ kind: "update-all" });
  });

  it("占位条件后面跟注释也照样拦（正则在这里会漏）", () => {
    // 尾随注释让「整段文本就是 1=1」不成立；按 token 判才看得穿
    expect(dangerOf("delete from t where 1=1 -- 全表")).toMatchObject({ kind: "delete-all" });
    expect(dangerOf("update t set a = 1 where 1 = 1 /* 先清一遍 */")).toMatchObject({ kind: "update-all" });
  });

  it("占位条件不进 COUNT：它一行都筛不掉，不该多跑一次全表", () => {
    expect(dangerOf("delete from t where 1=1")).toMatchObject({ countSql: "select count(*) from t" });
    // 真条件要留着，预估才有意义
    expect(dangerOf("delete from t where 1=1 or id > 0")).toBeNull();
  });

  it("子查询里的 WHERE 不算数（关键用例）", () => {
    expect(dangerOf("update t set x = (select y from s where s.id = 1)")).toMatchObject({
      kind: "update-all", table: "t", countSql: "select count(*) from t",
    });
    expect(dangerOf("delete from t where id in (select id from s where s.x = 1)")).toBeNull();
  });

  it("有真实条件的 UPDATE / DELETE 不拦", () => {
    expect(dangerOf("delete from t where id = 1")).toBeNull();
    expect(dangerOf("update bd_material m set m.name = 'x' where m.id = 1")).toBeNull();
  });

  it("带别名的目标表保留别名，COUNT 用它", () => {
    expect(dangerOf("update bd_material m set m.name = 'x'")).toMatchObject({
      table: "bd_material m",
      countSql: "select count(*) from bd_material m",
    });
    expect(dangerOf("delete from bd_material m")).toMatchObject({
      countSql: "select count(*) from bd_material m",
    });
  });

  it("DROP / TRUNCATE 只提示不拦", () => {
    expect(dangerOf("drop table bd_material")).toMatchObject({ kind: "drop", advisory: true, table: "bd_material" });
    expect(dangerOf("truncate table bd_material")).toMatchObject({ kind: "truncate", advisory: true, table: "bd_material" });
    // 非表对象也提醒，别让它悄悄删掉视图
    expect(dangerOf("drop view v_mat")).toMatchObject({ kind: "drop", table: "v_mat" });
  });

  it("查询、INSERT、PL/SQL 块不判", () => {
    expect(dangerOf("select * from t")).toBeNull();
    expect(dangerOf("insert into t (a) values (1)")).toBeNull();
    expect(dangerOf("begin update t set a = 1; end;")).toBeNull();
  });

  it("前导注释不影响识别，注释里的 WHERE 也不算", () => {
    expect(dangerOf("-- 物料主档\nupdate t set a = 1")).toMatchObject({ kind: "update-all" });
    expect(dangerOf("/* where id = 1 */ delete from t")).toMatchObject({ kind: "delete-all" });
  });

  it("可更新视图认不出目标表就放过", () => {
    expect(dangerOf("update (select a from t) set a = 1")).toBeNull();
  });

  it("批量检查保留语句序号", () => {
    const found = dangerousStatements(["select 1 from dual", "delete from t", "update t set a = 1 where id = 2"]);
    expect(found.map(f => f.index)).toEqual([1]);
    expect(found[0].sql).toBe("delete from t");
  });
});
