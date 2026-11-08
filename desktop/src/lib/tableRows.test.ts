import { describe, expect, it } from "vitest";
import { draftCells, missingRequired, newDraftRow, rowsWithDrafts } from "./tableRows";
import type { ColumnInfo, ColumnMeta } from "./dbApi";

const pageColumns: ColumnMeta[] = [
  { name: "CODE", type: "VARCHAR2(40)", precision: 40, scale: 0 },
  { name: "QTY", type: "NUMBER(28,8)", precision: 28, scale: 8 },
  { name: "MEMO", type: "VARCHAR2(200)", precision: 200, scale: 0 },
];

const info: ColumnInfo[] = [
  { name: "CODE", type: "VARCHAR2", size: 40, full: "VARCHAR2(40)", nullable: false, pk: true, default: null, comment: null, zh: "编码" },
  { name: "QTY", type: "NUMBER", size: 22, full: "NUMBER(28,8)", nullable: false, pk: false, default: null, comment: null, zh: null },
  { name: "MEMO", type: "VARCHAR2", size: 200, full: "VARCHAR2(200)", nullable: true, pk: false, default: null, comment: null, zh: null },
  { name: "TS", type: "DATE", size: 7, full: "DATE", nullable: false, pk: false, default: "sysdate", comment: null, zh: null },
];

describe("missingRequired", () => {
  it("非空且无默认值的列没填就报出来", () => {
    expect(missingRequired(pageColumns, info, new Map())).toEqual(["CODE", "QTY"]);
  });

  it("填过的列不再报", () => {
    expect(missingRequired(pageColumns, info, new Map([[0, "A"]]))).toEqual(["QTY"]);
  });

  it("可空列和有默认值的列不算必填", () => {
    // MEMO 可空、TS 有 sysdate 默认值，两者都不该出现在必填里
    const names = missingRequired([...pageColumns, { name: "TS", type: "DATE", precision: 0, scale: 0 }], info, new Map([[0, "A"]]));
    expect(names).toEqual(["QTY"]);
    expect(names).not.toContain("MEMO");
    expect(names).not.toContain("TS");
  });

  it("显式填 NULL 按「没填」处理", () => {
    expect(missingRequired(pageColumns, info, new Map([[0, null]]))).toContain("CODE");
  });

  it("没有表结构信息时不做本地校验（交给数据库报错）", () => {
    expect(missingRequired(pageColumns, [], new Map())).toEqual([]);
  });
});

describe("draftCells / rowsWithDrafts", () => {
  it("没填的列渲染成 NULL，填过的列按值显示", () => {
    const draft = newDraftRow();
    draft.values.set(1, "5");
    expect(draftCells(3, draft)).toEqual([null, "5", null]);
  });

  it("新增行接在查询结果后面，原行下标不变", () => {
    const rows = [["A", "1", null]];
    const draft = newDraftRow();
    draft.values.set(0, "B");
    const merged = rowsWithDrafts(rows, [draft], 3);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(rows[0]);
    expect(merged[1]).toEqual(["B", null, null]);
  });

  it("没有草稿时返回原数组（不制造无意义的新引用）", () => {
    const rows = [["A", "1", null]];
    expect(rowsWithDrafts(rows, [], 3)).toBe(rows);
  });
});
