import { describe, expect, it } from "vitest";
import { appendChunk, emptyLogState } from "./serverLog";
import { isLaunchCommand, rowAtOffset, serviceLogMatches, serviceLogRows } from "./serviceLogRows";

describe("控制台阅读模型", () => {
  const lines = appendChunk(emptyLogState(), "INFO 开始\nERROR 请求失败\n    at foo.Bar.run(Bar.java:42)\nCaused by: java.sql.SQLException: ORA-00942\nINFO 结束\n").lines;
  it("折叠异常后仍保留所有原始行，展开逐行生成虚拟项", () => {
    expect(serviceLogRows(lines, new Set(), "").map(row => row.kind)).toEqual(["line", "exception", "line"]);
    expect(serviceLogRows(lines, new Set([2]), "").map(row => row.kind)).toEqual(["line", "exception", "stack", "stack", "actions", "line"]);
    expect(lines).toHaveLength(5);
  });
  it("查找栈内部内容自动展开并指向原行，过滤不是查找", () => {
    expect(serviceLogRows(lines, new Set(), "ora-00942").some(row => row.kind === "stack" && row.line.id === 4)).toBe(true);
    expect(serviceLogMatches(lines, "ORA-00942")).toEqual([{ id: 4, recordId: 2 }]);
  });
  it("识别长Java命令，普通业务句子保留正文", () => {
    const command = appendChunk(emptyLogState(), `D:\\jdk\\java.exe -cp ${"a".repeat(200)}\n`).lines[0];
    expect(isLaunchCommand(command)).toBe(true);
    expect(serviceLogRows([command], new Set(), "")).toHaveLength(1);
    expect(serviceLogRows([command], new Set([command.id]), "").map(row => row.kind)).toEqual(["command", "commandText"]);
    expect(isLaunchCommand(lines[0])).toBe(false);
  });
  it("4000行均有可到达虚拟位置，而不是只保留最后500行", () => {
    const all = appendChunk(emptyLogState(), Array.from({ length: 4000 }, (_, index) => `INFO row-${index}\n`).join("")).lines;
    const rows = serviceLogRows(all, new Set(), "");
    expect(rows).toHaveLength(4000); expect(rows[0].line.text).toBe("row-0");
    const offsets = Array.from({ length: 4001 }, (_, index) => index * 23);
    expect(rowAtOffset(offsets, 0)).toBe(0); expect(rowAtOffset(offsets, 3500 * 23 + 2)).toBe(3500); expect(rowAtOffset(offsets, Infinity)).toBe(3999);
  });
});
