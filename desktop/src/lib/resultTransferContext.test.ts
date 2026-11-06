import { describe, expect, it } from "vitest";
import { freezeTransferFrame, scopedTransferData, scopeIndices, selectionIndices, transferCanRequery, type TransferFrame, type TransferSource } from "./resultTransferContext";

const source = (sql = "select * from T"): TransferSource => ({ connId: "conn-a", resultId: "result-a", source: "测试连接", sql, complete: false });
function frame(): TransferFrame {
  const columns = ["ID", "NAME", "NOTE"].map(name => ({ name, type: "VARCHAR2", precision: 0, scale: 0 }));
  return {
    data: { columns, originalRows: [["1", "old-a", "note-a"], ["2", "old-b", "note-b"], ["3", "old-c", "note-c"]], rows: [["changed-id", "new-a", "note-a"], ["2", "new-b", "note-b"], ["3", "new-c", "note-c"]] },
    order: [2, 0], visible: [2, 0], selection: { anchor: { r: 2, c: 2 }, end: { r: 0, c: 0 } },
    labels: ["编号", "名称", "说明"], source: source(),
  };
}

describe("输出范围与数据快照", () => {
  it("筛选排序后的矩形选区保持原始行列索引，已加载范围仍包括被筛掉的行", () => {
    const value = frame();
    expect(selectionIndices(value)).toEqual([2, 0]);
    expect(scopeIndices(value, "selection")).toEqual([2, 0]);
    expect(scopeIndices(value, "filtered")).toEqual([2, 0]);
    expect(scopeIndices(value, "loaded")).toEqual([0, 1, 2]);
    expect(scopeIndices(value, "query")).toEqual([0, 1, 2]);
    expect(scopedTransferData(value, "selection", true).rows).toEqual([["3", "new-c", "note-c"], ["changed-id", "new-a", "note-a"]]);
    expect(scopedTransferData(value, "selection", false).rows).toEqual([["3", "old-c", "note-c"], ["1", "old-a", "note-a"]]);
    expect(scopedTransferData(value, "query", true).rows[0][0]).toBe("1");
  });

  it("没有选区时只使用当前可见列与筛选顺序，隐藏的端点不会扩大选区", () => {
    const value = frame(); value.selection = null;
    expect(selectionIndices(value)).toEqual([2, 0]);
    expect(scopeIndices(value, "selection")).toEqual([2, 0]);
    value.selection = { anchor: { r: 2, c: 1 }, end: { r: 0, c: 0 } };
    expect(selectionIndices(value)).toEqual([]);
    value.selection = { anchor: { r: 1, c: 2 }, end: { r: 0, c: 0 } };
    expect(scopeIndices(value, "selection")).toEqual([]);
  });

  it("冻结后编辑值、查询原值、连接参数、选择和结果集都独立于原快照", () => {
    const value = frame();
    value.source.params = [{ number: "12345678901234567890" }, "bind-text", null];
    value.source.keys = ["ID"];
    value.source.sheets = [{ name: "结果2", data: { columns: [{ ...value.data.columns[0] }], rows: [["sheet-current"]], originalRows: [["sheet-original"]], query: "select ID from T2" } }];
    const frozen = freezeTransferFrame(value, (r, c) => c === 1 ? `edit-${r}` : value.data.rows[r][c]);
    value.data.rows[0][0] = "later-edit";
    value.data.originalRows![0][0] = "later-original";
    value.data.columns[0].name = "LATER_COLUMN";
    value.order.reverse(); value.visible.reverse(); value.labels[0] = "稍后"; value.selection!.anchor.r = 0;
    value.source.connId = "conn-b"; value.source.sql = "delete from T";
    (value.source.params![0] as { number: string }).number = "later-number";
    value.source.params![1] = "later-bind";
    value.source.keys![0] = "LATER_KEY";
    value.source.sheets![0].name = "稍后结果";
    value.source.sheets![0].data.columns[0].name = "LATER_SHEET_COLUMN";
    value.source.sheets![0].data.rows[0][0] = "later-sheet";
    value.source.sheets![0].data.originalRows![0][0] = "later-sheet-original";
    expect(frozen.data.rows[0]).toEqual(["changed-id", "edit-0", "note-a"]);
    expect(frozen.data.originalRows![0]).toEqual(["1", "old-a", "note-a"]);
    expect(frozen.data.columns[0].name).toBe("ID");
    expect(frozen.order).toEqual([2, 0]); expect(frozen.visible).toEqual([2, 0]); expect(frozen.labels[0]).toBe("编号");
    expect(frozen.selection!.anchor.r).toBe(2);
    expect(frozen.source.connId).toBe("conn-a"); expect(frozen.source.sql).toBe("select * from T");
    expect(frozen.source.params).toEqual([{ number: "12345678901234567890" }, "bind-text", null]);
    expect(frozen.source.keys).toEqual(["ID"]);
    expect(frozen.source.sheets![0]).toEqual({ name: "结果2", data: { columns: [{ name: "ID", type: "VARCHAR2", precision: 0, scale: 0 }], rows: [["sheet-current"]], originalRows: [["sheet-original"]], query: "select ID from T2" } });
  });

  it("未提供 originalRows 时冻结加载值作为原值，不把编辑回调写入原值", () => {
    const value = frame(); value.data.originalRows = undefined;
    const frozen = freezeTransferFrame(value, () => "edited");
    expect(frozen.data.originalRows![0]).toEqual(["changed-id", "new-a", "note-a"]);
    expect(frozen.data.rows[0]).toEqual(["edited", "edited", "edited"]);
  });
});

describe("重新查询许可", () => {
  it.each(["select * from T", "-- note\n/* source */ select q'[value; still one statement]' from dual", "with x as (select 1 n from dual) select n from x"])("单条只读查询可重查：%s", sql => {
    expect(transferCanRequery(source(sql))).toBe(true);
  });
  it.each(["begin dbms_sql.return_result(:cursor); end;", "declare n number; begin insert into T values (1); end;", "call package_name.run()", "select 1 from dual; delete from T", "update T set VALUE = 1", "", "/* only comment */"])("过程、多语句和写入不能重放：%s", sql => {
    expect(transferCanRequery(source(sql))).toBe(false);
  });
  it("连接缺失或调用方明确禁用重查时拒绝，即使SQL是SELECT", () => {
    expect(transferCanRequery({ ...source(), connId: null })).toBe(false);
    expect(transferCanRequery({ ...source(), canRequery: false })).toBe(false);
  });
});
