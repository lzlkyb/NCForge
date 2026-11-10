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

  it("大文本预览不能当新增值写入（网格里只有前 8K）", () => {
    const preview = `{"k":"${"x".repeat(10)}"} …（共 20000 个字符，只显示前 8192，点「加载完整值」查看）`;
    expect(() => insertChange("t", cols, new Map([[2, preview]]), 0)).toThrow("只有前 8K");
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

  it("同一行既删又改时只发删除（UPDATE 会先撞空）", () => {
    const plan = planWriteBack([change("update", 2), change("delete", 2), change("update", 1)]);
    expect(plan.map(c => `${c.kind}:${c.row}`)).toEqual(["delete:2", "update:1"]);
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

describe("SQL 结果页的定位方式", () => {
  const resultCols: ColumnMeta[] = [
    { ...cols[0], name: "编码" },
    { ...cols[1], name: "QTY" },
    { name: "ROWID", type: "ROWID", precision: 0, scale: 0 },
  ];
  const sourceName = (i: number) => (i === 0 ? "CODE" : i === 1 ? "QTY" : null);

  it("别名列按源表列写回", () => {
    const changes = optimisticChanges("t", resultCols, [["A", "1", "rid"]], [], new Map([["0:1", "2"]]),
      { keyCols: [0], sourceName });
    expect(changes[0].sql).toBe("update t set QTY = :1 where CODE = :2 and QTY = :3");
  });

  it("有 ROWID 时按 rowid 定位，不再依赖主键", () => {
    const changes = optimisticChanges("t", resultCols, [["A", "1", "rid"]], [], new Map([["0:1", "2"]]),
      { rowidCol: 2, sourceName });
    expect(changes[0].sql).toBe("update t set QTY = :1 where rowid = :2 and QTY = :3");
    expect(changes[0].params).toEqual([{ number: "2" }, "rid", { number: "1" }]);
  });

  it("ROWID 为空时拒绝写回（行号会落到别的行）", () => {
    expect(() => optimisticChanges("t", resultCols, [["A", "1", null]], [], new Map([["0:1", "2"]]),
      { rowidCol: 2, sourceName })).toThrow("没有 ROWID");
  });

  it("ROWID 删除与别名新增都按源表列", () => {
    const del = deleteChange("t", resultCols, ["A", "1", "rid"], [], 0, { rowidCol: 2, sourceName });
    expect(del.sql).toBe("delete from t where rowid = :1");
    const ins = insertChange("t", resultCols, new Map([[0, "A"], [1, "3"]]), 0, { sourceName });
    expect(ins.sql).toBe("insert into t (CODE, QTY) values (:1, :2)");
  });
});
