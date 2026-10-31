/**
 * 导入分批 / 行号换算。
 *
 * 唯一且致命的点：**报错的行号要能对回文件**。用户在 Excel 里看到的是第 7 行，
 * 界面上报"第 5 行"就等于什么都没说——而他正拿着这个行号去改数据。
 * 表头占第 1 行，所以第 i 条数据（0 起）在文件第 i + 2 行，分批后每批起点都要 +2。
 */
import { describe, expect, it } from "vitest";

import { planImport, type Mapping, type TargetCol } from "./csvImport";
import { parseCsv } from "./csvParse";

const TABLE: TargetCol[] = [
  { name: "ID", type: "NUMBER" },
  { name: "NAME", type: "VARCHAR2" },
  { name: "CREATED", type: "DATE" },
];

const mapAll = (n: number): Mapping[] => Array.from({ length: n }, (_, i) => ({ to: i, from: i }));

describe("planImport", () => {
  it("按批切开且每批起始行号对回文件（表头算第 1 行）", () => {
    const header = "ID,NAME,CREATED";
    const body = Array.from({ length: 450 }, (_, i) => `${i},n${i},2026-10-31 10:00:00`);
    const csv = parseCsv([header, ...body].join("\n"));

    const plan = planImport(csv, TABLE, mapAll(3), 200);
    expect(plan.chunks.map((c) => c.rows.length)).toEqual([200, 200, 50]);
    // 第 0 条数据在文件第 2 行；第 200 条在第 202 行；第 400 条在第 402 行
    expect(plan.chunks.map((c) => c.startLine)).toEqual([2, 202, 402]);
  });

  it("列名与类型按映射顺序取，跳过的列不出现", () => {
    const csv = parseCsv("A,B,C\n1,2,3\n");
    // 只导 B 和 A（顺序故意反过来：列的先后由用户选的映射决定，不是文件顺序）
    const picked: Mapping[] = [
      { to: 1, from: 1 },
      { to: 0, from: 0 },
    ];
    const plan = planImport(csv, TABLE, picked, 200);
    expect(plan.columns).toEqual([
      { name: "NAME", ty: "VARCHAR2" },
      { name: "ID", ty: "NUMBER" },
    ]);
    expect(plan.chunks[0].rows).toEqual([["2", "1"]]);
  });

  it("行比映射短时补 null，不越界读成 undefined", () => {
    const csv = parseCsv("A,B,C\n1,2,3\n4\n");
    const plan = planImport(csv, TABLE, mapAll(3), 200);
    expect(plan.chunks[0].rows[1]).toEqual(["4", null, null]);
  });

  it("空单元格原样留空串（写 NULL 是后端的口径，前端不提前转）", () => {
    const csv = parseCsv("A,B,C\n1,,3\n");
    const plan = planImport(csv, TABLE, mapAll(3), 200);
    expect(plan.chunks[0].rows[0]).toEqual(["1", "", "3"]);
  });

  it("batch 传 0 不会死循环", () => {
    const csv = parseCsv("A\n1\n2\n");
    const plan = planImport(csv, TABLE, [{ to: 0, from: 0 }], 0);
    expect(plan.chunks.map((c) => c.rows.length)).toEqual([1, 1]);
    expect(plan.chunks.map((c) => c.startLine)).toEqual([2, 3]);
  });

  it("只有表头时没有任何批（执行按钮该是灰的）", () => {
    const csv = parseCsv("A,B,C");
    expect(planImport(csv, TABLE, mapAll(3), 200).chunks).toEqual([]);
  });
});
