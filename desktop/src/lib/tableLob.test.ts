/**
 * 表页「加载完整值」的行定位。
 *
 * 定位 SQL 一旦拼错，`lobValue` 要么报 ORA、要么更糟：定位到另一行，把别人的大文本显示出来。
 * 所以这里盯的是「拼不出唯一行就返回 null」，而不是尽量拼一个能跑的。
 */
import { describe, expect, it } from "vitest";

import type { ColumnMeta } from "./dbApi";
import { rowLocatorSql } from "./tableLob";

const col = (name: string, type: string): ColumnMeta => ({ name, type, precision: 0, scale: 0 });

describe("rowLocatorSql", () => {
  it("单主键：表名与列名转小写，字符串带引号", () => {
    const columns = [col("PK_MATERIAL", "VARCHAR2(40)"), col("NAME", "VARCHAR2(100)")];
    expect(rowLocatorSql("BD_MATERIAL", columns, ["1001", "螺母"], ["pk_material"]))
      .toBe("select * from bd_material where pk_material = '1001'");
  });

  it("复合主键：全部按 and 拼上", () => {
    const columns = [col("PK_ORG", "VARCHAR2(20)"), col("BILLNO", "VARCHAR2(30)"), col("TS", "DATE")];
    expect(rowLocatorSql("ic_bill", columns, ["01", "CG-1", "2026-11-10 10:42:00"], ["PK_ORG", "BILLNO"]))
      .toBe("select * from ic_bill where pk_org = '01' and billno = 'CG-1'");
  });

  it("数字主键不加引号", () => {
    const columns = [col("ID", "NUMBER(19)")];
    expect(rowLocatorSql("log_line", columns, [42], ["id"])).toBe("select * from log_line where id = 42");
  });

  it("主键名大小写不敏感（列清单来自另一条语句的元数据）", () => {
    const columns = [col("pk_material", "VARCHAR2(40)")];
    expect(rowLocatorSql("bd_material", columns, ["x"], ["PK_MATERIAL"])).not.toBeNull();
  });

  it("没有主键 / 主键值为 NULL / 主键列不在这一页：都返回 null（不给入口）", () => {
    const columns = [col("PK_MATERIAL", "VARCHAR2(40)")];
    expect(rowLocatorSql("bd_material", columns, ["x"], [])).toBeNull();
    expect(rowLocatorSql("bd_material", columns, [null], ["PK_MATERIAL"])).toBeNull();
    expect(rowLocatorSql("bd_material", columns, [], ["PK_MATERIAL"])).toBeNull();
    expect(rowLocatorSql("bd_material", columns, ["x"], ["NOT_THERE"])).toBeNull();
  });

  it("主键值是空串：能定位（WHERE pk = ''），不能当成 NULL 丢掉", () => {
    const columns = [col("PK_ORG", "VARCHAR2(20)")];
    expect(rowLocatorSql("org", columns, [""], ["pk_org"])).toBe("select * from org where pk_org = ''");
  });
});
