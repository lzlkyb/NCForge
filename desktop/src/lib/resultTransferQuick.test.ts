import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ copy: vi.fn(async () => true) }));
vi.mock("./resultTransferClipboard", () => ({ copyTransfer: mocks.copy }));
import { quickCopyTransfer } from "./resultTransferQuick";
import { serializeTransfer, type TransferData, type TransferOptions } from "./resultTransfer";
import type { TransferFrame, TransferSource } from "./resultTransferContext";

function frame(): TransferFrame {
  return { data: { columns: ["ID", "HIDDEN", "TEXT"].map(name => ({ name, type: "VARCHAR2", precision: 0, scale: 0 })), rows: [["1", "hidden-a", "edited-a"], ["2", "hidden-b", "edited-b"], ["3", "hidden-c", "edited-c"]], originalRows: [["1", "hidden-a", "original-a"], ["2", "hidden-b", "original-b"], ["3", "hidden-c", "original-c"]] },
    order: [2, 0], visible: [2, 0], selection: { anchor: { r: 2, c: 2 }, end: { r: 0, c: 0 } }, labels: ["编号", "隐藏列", "说明"],
    source: { connId: "conn-a", resultId: "result-a", sql: "select * from T", source: "测试连接", complete: false, table: "T" } };
}
const args = () => mocks.copy.mock.calls[0] as unknown as [TransferData, TransferOptions, TransferSource, boolean];
beforeEach(() => mocks.copy.mockClear());

describe("快捷复制范围", () => {
  it.each(["tsv", "csv", "json", "markdown", "html", "insert"] as const)("切换%s时保持选区、列顺序和编辑值", async format => {
    await quickCopyTransfer(frame(), format);
    const [data, options, source, raw] = args();
    expect(data.rows).toEqual([["3", "hidden-c", "edited-c"], ["1", "hidden-a", "edited-a"]]);
    expect(data.originalRows).toEqual([["3", "hidden-c", "original-c"], ["1", "hidden-a", "original-a"]]);
    expect(options.columnIndices).toEqual([2, 0]); expect(options.header).toBe("none");
    expect(source.connId).toBe("conn-a"); expect(source.resultId).toBe("result-a"); expect(raw).toBe(false);
    if (format === "json") expect(JSON.parse(serializeTransfer(data, options))).toEqual([{ TEXT: "edited-c", ID: "3" }, { TEXT: "edited-a", ID: "1" }]);
  });
  it("无选区时使用筛选后的可见列并带表头", async () => {
    const value = frame(); value.selection = null;
    await quickCopyTransfer(value, "csv");
    const [data, options] = args();
    expect(options.columnIndices).toEqual([2, 0]); expect(options.header).toBe("name");
    expect(serializeTransfer(data, { ...options, bom: false })).toBe("TEXT,ID\r\nedited-c,3\r\nedited-a,1");
  });
  it("单格TSV使用原始完整文本，其他格式仍序列化", async () => {
    const value = frame(); value.selection = { anchor: { r: 0, c: 2 }, end: { r: 0, c: 2 } };
    value.data.rows[0][2] = "=FORMULA\tfull\ntext";
    await quickCopyTransfer(value);
    expect(args()[0].rows[0][2]).toBe("=FORMULA\tfull\ntext"); expect(args()[3]).toBe(true);
    mocks.copy.mockClear(); await quickCopyTransfer(value, "json"); expect(args()[3]).toBe(false);
  });
  it("隐藏选区端点或没有可见列时不调用剪贴板", async () => {
    const value = frame(); value.selection!.anchor.c = 1;
    expect(await quickCopyTransfer(value)).toBe(false); expect(mocks.copy).not.toHaveBeenCalled();
    value.selection = null; value.visible = [];
    expect(await quickCopyTransfer(value)).toBe(false); expect(mocks.copy).not.toHaveBeenCalled();
  });
  it("不能猜出目标表时清空INSERT映射，保留来源以提供错误反馈", async () => {
    const value = frame(); value.source.table = "表名";
    await quickCopyTransfer(value, "insert"); expect(args()[1].table).toBe(""); expect(args()[2].sql).toBe(value.source.sql);
  });
});
