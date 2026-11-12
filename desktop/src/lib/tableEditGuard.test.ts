import { expect, it } from "vitest";
import { tableBlockedHint, tableCellEditable, tableFootHint } from "./tableEditGuard";
import type { Cell, ColumnMeta } from "./dbApi";

/**
 * 表页「能不能改」的三个出口必须同一口径。
 *
 * 以前这段在 `TableData` 里抄了三份：`canEdit` 判类型、`blockedHint` 判结构、
 * 页脚 hint 再拼一次。改一处漏两处，就会出现「页脚说没有主键只读，双击却弹
 * 正在查询」这种自相矛盾。这里逐条钉死。
 */
const col = (name: string, type: string): ColumnMeta => ({ name, type } as ColumnMeta);
const cols = [col("ID", "NUMBER"), col("NAME", "VARCHAR2(50)"), col("TZ", "TIMESTAMP WITH TIME ZONE")];
const rows: Cell[][] = [["1", "a", "2026-01-01"], ["2", "b", "2026-01-02"]];

it("类型不在白名单、带时区的时间戳都不给改", () => {
  expect(tableCellEditable(cols, rows, ["ID"], 1, 0)).toBe(true);
  expect(tableCellEditable(cols, rows, ["ID"], 2, 0)).toBe(false);
});

it("主键列：已有行不能改，新增草稿行必须能填", () => {
  expect(tableCellEditable(cols, rows, ["ID"], 0, 0)).toBe(false);
  expect(tableCellEditable(cols, rows, ["ID"], 0, 2)).toBe(true);
});

it("大文本预览不给改（改了会把 8K 说明当数据写回）", () => {
  const lobCols = [col("BODY", "CLOB"), col("NAME", "VARCHAR2(50)")];
  const lobRows: Cell[][] = [["abcdefgh …（共 40960 个字符，只显示前 8192，点「加载完整值」查看）", "a"]];
  // 同一行里 CLOB 那格拒绝、普通文本列照旧可改：这是逐格的判据，不是整行连坐。
  expect(tableCellEditable(lobCols, lobRows, ["ID"], 0, 0)).toBe(false);
  expect(tableCellEditable(lobCols, lobRows, ["ID"], 1, 0)).toBe(true);
});

it("双击提示只说结构性原因，临时状态不弹", () => {
  expect(tableBlockedHint({ readonly: true, isView: false, pk: ["ID"] })).toBe("当前连接是只读模式");
  expect(tableBlockedHint({ readonly: false, isView: true, pk: ["ID"] })).toBe("视图不能直接改数据");
  expect(tableBlockedHint({ readonly: false, isView: false, pk: [] })).toContain("没有主键");
  // readonly 未知（null）当未只读；正在查询/写回不属于结构性原因，不弹。
  expect(tableBlockedHint({ readonly: null, isView: false, pk: ["ID"] })).toBeUndefined();
});

it("页脚说明按结构优先、临时状态兜底，并带上等待上限", () => {
  expect(tableFootHint({ readonly: true, isView: true, pk: [], editable: false, timeoutSec: 60 })).toBe("只读查询模式 · 等待上限 60s");
  expect(tableFootHint({ readonly: false, isView: true, pk: ["ID"], editable: false, timeoutSec: 60 })).toBe("视图只读 · 等待上限 60s");
  expect(tableFootHint({ readonly: false, isView: false, pk: [], editable: false, timeoutSec: 30 })).toContain("没有主键");
  expect(tableFootHint({ readonly: false, isView: false, pk: ["ID"], editable: true, timeoutSec: 60 })).toContain("双击单元格编辑");
  // 能改但此刻锁着（查询中 / 写回中）：说「暂时」，别让人以为这表永远只读。
  expect(tableFootHint({ readonly: false, isView: false, pk: ["ID"], editable: false, timeoutSec: 60 })).toContain("暂时不可编辑");
});
