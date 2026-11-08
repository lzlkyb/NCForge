import { describe, expect, it } from "vitest";
import { deleteChange, insertChange, optimisticChanges, planWriteBack } from "./dbOptimisticEdit";
import type { ColumnMeta } from "./dbApi";

const cols: ColumnMeta[] = [
  { name: "CODE", type: "VARCHAR2(40)", precision: 40, scale: 0 },
  { name: "QTY", type: "NUMBER(28,8)", precision: 28, scale: 8 },
  { name: "MEMO", type: "CLOB", precision: 0, scale: 0 },
];

describe("insertChange", () => {
  it("只写填过的列，没填的交给数据库默认值", () => {
    const change = insertChange("bd_material", cols, new Map([[0, "A"], [1, "3"]]), 7);
    expect(change.kind).toBe("insert");
    expect(change.sql).toBe("insert into bd_material (CODE, QTY) values (:1, :2)");
    expect(change.params).toEqual(["A", { number: "3" }]);
    expect(change.cells.map(c => c.column)).toEqual([0, 1]);
  });

  it("显式 NULL 也进 SQL（空着和 NULL 是两件事）", () => {
    const change = insertChange("t", cols, new Map([[0, null]]), 0);
    expect(change.sql).toBe("insert into t (CODE) values (:1)");
    expect(change.params).toEqual([null]);
  });

  it("CLOB 走 to_clob 绑定，避免长文本被当 VARCHAR2 截断", () => {
    const change = insertChange("t", cols, new Map([[2, "x"]]), 0);
    expect(change.sql).toContain("to_clob(:1)");
  });

  it("一个值都没有时直接拒绝", () => {
    expect(() => insertChange("t", cols, new Map(), 0)).toThrow("没有任何值");
  });
});

describe("deleteChange", () => {
  it("按主键定位整行", () => {
    const change = deleteChange("t", cols, ["A", "3", null], ["CODE"], 2);
    expect(change.kind).toBe("delete");
    expect(change.sql).toBe("delete from t where CODE = :1");
    expect(change.params).toEqual(["A"]);
    expect(change.row).toBe(2);
  });

  it("主键为空时拒绝（否则会删掉整表）", () => {
    expect(() => deleteChange("t", cols, [null, "3", null], ["CODE"], 0)).toThrow("主键为空");
  });
});

describe("planWriteBack", () => {
  const change = (kind: "insert" | "update" | "delete", row: number) =>
    ({ kind, row, sql: "", params: [], cells: [] });

  it("先删、再改、后插", () => {
    const plan = planWriteBack([change("insert", 5), change("update", 1), change("delete", 2)]);
    expect(plan.map(c => `${c.kind}:${c.row}`)).toEqual(["delete:2", "update:1", "insert:5"]);
  });

  it("新增行倒序：移除草稿不会把还没写回的行号顶偏", () => {
    const plan = planWriteBack([change("insert", 5), change("insert", 6), change("insert", 7)]);
    expect(plan.map(c => c.row)).toEqual([7, 6, 5]);
  });
});

describe("optimisticChanges", () => {
  it("原值校验条件包含被改字段（别人先改了就不写）", () => {
    const rows = [["A", "1", null]];
    const changes = optimisticChanges("t", cols, rows, ["CODE"], new Map([["0:1", "2"]]));
    expect(changes[0].kind).toBe("update");
    expect(changes[0].sql).toBe("update t set QTY = :1 where CODE = :2 and QTY = :3");
  });
});
