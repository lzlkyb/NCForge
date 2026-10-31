// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));

import { __resetDbForTest, execOne, openSqlTab, summaryOf, type ResultEntry } from "./dbStore";

/**
 * 结果摘要（结果标签上那截小字）。
 *
 * 重点是**多结果集**：`dbms_sql.return_result` 一次能带回好几张表，
 * 这时按第一个结果集报行数会让用户以为其它结果集也是这么点行。
 */

const base: ResultEntry = {
  id: "r1",
  index: 1,
  sql: "select 1 from dual",
  kind: "rows",
  columns: [],
  rows: [],
  hasMore: false,
  updateCount: -1,
  ms: 12,
};

describe("summaryOf", () => {
  it("单结果集报行数，取满加 +", () => {
    expect(summaryOf({ ...base, rows: [[1], [2]] })).toBe("2 行");
    expect(summaryOf({ ...base, rows: [[1]], hasMore: true })).toBe("1+ 行");
  });

  it("多结果集报个数（不是第一个的行数）", () => {
    const sets = [
      { columns: [], rows: [[1]], rowCount: 1, hasMore: false },
      { columns: [], rows: [[1], [2], [3]], rowCount: 3, hasMore: false },
    ];
    // 顶层 rows 是第一个结果集，若照旧报「1 行」就漏掉了后面那两张表
    expect(summaryOf({ ...base, rows: [[1]], sets })).toBe("2 个结果集");
  });

  it("只有一个结果集时仍报行数（`return_result` 一次也算普通结果）", () => {
    const sets = [{ columns: [], rows: [[1], [2]], rowCount: 2, hasMore: false }];
    expect(summaryOf({ ...base, rows: [[1], [2]], sets })).toBe("2 行");
  });

  it("写语句与出错各给人话", () => {
    expect(summaryOf({ ...base, kind: "update", updateCount: 3 })).toBe("更新 3 行");
    expect(summaryOf({ ...base, kind: "update", updateCount: -1 })).toBe("已执行");
    expect(summaryOf({ ...base, kind: "error", error: "ORA-00942: 表或视图不存在" })).toBe("ORA-00942");
  });
});

describe("execOne 把 sets 带到结果条目上", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    __resetDbForTest();
  });

  it("后端给了 sets 就不能丢（丢了界面只剩第一张表）", async () => {
    mocks.invoke.mockResolvedValue({
      kind: "rows",
      columns: [{ name: "A", type: "NUMBER", precision: 10, scale: 0 }],
      rows: [["1"]],
      rowCount: 1,
      hasMore: false,
      sets: [
        { columns: [{ name: "A", type: "NUMBER", precision: 10, scale: 0 }], rows: [["1"]], rowCount: 1, hasMore: false },
        { columns: [{ name: "S", type: "VARCHAR2(10)", precision: 10, scale: 0 }], rows: [["x"]], rowCount: 1, hasMore: true },
      ],
      ms: 5,
      output: [],
      tx: { autoCommit: true, statements: 0, rows: 0, since: 0 },
    });
    const tabId = openSqlTab("c1", "select 1 from dual");
    const e = await execOne(tabId, "select 1 from dual", 1);
    expect(e.kind).toBe("rows");
    expect(e.sets).toHaveLength(2);
    expect(e.sets?.[1].hasMore).toBe(true);
    expect(summaryOf(e)).toBe("2 个结果集");
  });
});
