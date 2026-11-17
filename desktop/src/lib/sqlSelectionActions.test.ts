import { describe, expect, it } from "vitest";
import { sqlSelectionActions } from "./sqlSelectionActions";

/** 按「选中某段文字」调用判定：`start`/`end` 与编辑器里拖蓝一致。 */
const pick = (sql: string, text: string, dialect: "plsql" | "sql" = "plsql") => {
  const start = sql.indexOf(text);
  return sqlSelectionActions(sql, start, start + text.length, dialect);
};
const ids = (sql: string, text: string, dialect?: "plsql" | "sql") => pick(sql, text, dialect).map(a => a.id);

describe("选区上的 SQL 动作", () => {
  // 真实的用法是「先写 where code，再把 Excel 那一列粘进去」——值紧跟在字段名后面，
  // 中间只有空白。写成 `code = 'A001'` 反而不成立（等号不是字段名）。
  it("选中 WHERE 里的一列值只给「转为 IN 条件」", () => {
    expect(ids("select * from po_order where code\n'A001'", "'A001'")).toEqual(["batch.in"]);
    expect(ids("select * from po_order where code in ('a','b')", "'a','b'")).toEqual(["batch.in"]);
  });
  it("选中 SELECT 投影里的字段列表给查重与汇总", () => {
    expect(ids("select vbillcode, dbilldate from po_order where dr = 0", "vbillcode, dbilldate"))
      .toEqual(["check.duplicates", "check.summary"]);
  });
  it("空选区、越界区间什么都不给", () => {
    const sql = "select 1 from dual";
    expect(sqlSelectionActions(sql, 3, 3, "plsql")).toEqual([]);
    expect(sqlSelectionActions(sql, -1, 4, "plsql")).toEqual([]);
    expect(sqlSelectionActions(sql, 3, sql.length + 5, "plsql")).toEqual([]);
  });
  it("选中的既不是值也不是字段列表时不给", () => {
    expect(ids("select * from po_order where dr = 0", "po_order where")).toEqual([]);
  });
  // 查重/汇总内部是写死 plsql 的解析器，非 Oracle 方言不能把它们端出来。
  it("非 Oracle 方言不给查重与汇总", () => {
    expect(ids("select vbillcode, dbilldate from po_order where dr = 0", "vbillcode, dbilldate", "sql")).toEqual([]);
  });
  it("每条动作都指向已注册的 editor action", () => {
    const actions = pick("select vbillcode, dbilldate from po_order where dr = 0", "vbillcode, dbilldate");
    expect(actions.every(a => a.actionId.startsWith("ncforge.sql."))).toBe(true);
  });
});
