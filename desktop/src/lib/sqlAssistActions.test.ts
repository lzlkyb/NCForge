import { describe, expect, it } from "vitest";
import { sqlActionsAt, type SqlActionInput } from "./sqlAssistActions";

const base: SqlActionInput = { plsql: true, templatesEnabled: true, bare: false, table: "po_order", relations: 3 };

describe("当前位置可用的 SQL 动作", () => {
  // 语句内只能追加：替换整条会把用户写好的 SELECT/WHERE 一起抹掉。
  it("语句内的表名上只给「追加 LEFT JOIN」", () => {
    expect(sqlActionsAt(base).map(a => a.id)).toEqual(["bill.join"]);
  });
  // 裸表名位置替换的是表名本身，整条联查放得进去。
  it("裸表名上给整条联查替换", () => {
    expect(sqlActionsAt({ ...base, bare: true }).map(a => a.id)).toEqual(["bill.query"]);
  });
  // 关系还没解析出来之前不给：说了「支持主子表联查」却点不动，比不说更糟。
  it("关系未知或表名没命中时一条都不给", () => {
    expect(sqlActionsAt({ ...base, relations: 0 })).toEqual([]);
    expect(sqlActionsAt({ ...base, table: "" })).toEqual([]);
  });
  it("非 Oracle 方言或模板开关关闭时都不给", () => {
    expect(sqlActionsAt({ ...base, plsql: false })).toEqual([]);
    expect(sqlActionsAt({ ...base, templatesEnabled: false })).toEqual([]);
  });
});
