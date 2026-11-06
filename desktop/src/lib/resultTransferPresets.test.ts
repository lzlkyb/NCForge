import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTransferOptions } from "./resultTransfer";
import { lastTransferFormat, rememberTransferFormat, readTransferPresets, saveTransferPreset } from "./resultTransferPresets";

const storage = new Map<string, string>();
const key = "ncforge-db-output-presets";
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe("输出预设安全字段", () => {
  it("记住格式和表头，复制与文件偏好独立，绝不恢复全量范围或定位键",()=>{
    rememberTransferFormat("file",{...defaultTransferOptions("jsonl"),header:"both",table:"SECRET",keys:[0],keysConfirmed:true});
    expect(lastTransferFormat("file")).toEqual({format:"jsonl",header:"both"});expect(lastTransferFormat("copy")).toEqual({format:"tsv",header:"name"});
    expect(storage.get(`${key}:last:file`)).toBe('{"format":"jsonl","header":"both"}');
    storage.set(`${key}:last:copy`,'{"format":"xlsx","header":"none","scope":"query"}');expect(lastTransferFormat("copy")).toEqual({format:"tsv",header:"none"});
  });
  it("只持久化格式选项，不持久化数据、SQL、绑定值、连接凭据、键确认和自动提交", () => {
    const unsafe = { ...defaultTransferOptions("csv"), table: "PRIVATE_T", schema: "PRIVATE_SCHEMA", keys: [0], keysConfirmed: true, columnIndices: [2, 0], columnLabels: ["内部名称"], nc: true, commitEvery: 10,
      sql: "select secret from T", data: { rows: [["private row"]] }, params: [{ number: "12345678901234567890" }], password: "private password", connId: "private connection", scope: "query" };
    saveTransferPreset("  数据交换  ", unsafe);
    const persisted = storage.get(key)!;
    expect(persisted).not.toMatch(/PRIVATE_|private|内部|select secret|keysConfirmed|columnIndices|columnLabels|commitEvery|connId|scope|params|password|"nc"/);
    expect(readTransferPresets()).toEqual([{ name: "数据交换", options: { format: "csv", header: "name", nullText: "", delimiter: ",", lineEnding: "crlf", bom: true, spreadsheetSafe: true, transpose: false, jsonStructure: "objects", includeQuery: false, condition: "in", includeNull: false } }]);
  });
  it("替换同名预设并只保留最近12个，不隐式保存范围", () => {
    for (let i = 0; i < 13; i++) saveTransferPreset(`预设${i}`, defaultTransferOptions("json"));
    expect(readTransferPresets()).toHaveLength(12); expect(readTransferPresets()[0].name).toBe("预设1");
    saveTransferPreset("预设5", defaultTransferOptions("csv"));
    expect(readTransferPresets()).toHaveLength(12); expect(readTransferPresets().filter(p => p.name === "预设5")).toHaveLength(1);
    const presets = readTransferPresets(); expect(presets[presets.length - 1].options.format).toBe("csv");
  });
  it("损坏存储不会中断输出，错误类型和非法非空枚举不会进入选项", () => {
    storage.set(key, "{bad JSON"); expect(readTransferPresets()).toEqual([]);
    storage.set(key, JSON.stringify([null, { name: " " }, { name: "有效", options: { format: "execute-script", header: "invalid", lineEnding: "invalid", jsonStructure: "invalid", condition: "invalid", spreadsheetSafe: "false", bom: 1, nullText: "\\N", password: "secret" } }]));
    expect(readTransferPresets()).toEqual([{ name: "有效", options: { nullText: "\\N" } }]);
  });
  it("空枚举字符串也应被剔除，避免前端默认处理与后端拒绝不一致", () => {
    storage.set(key, JSON.stringify([{ name: "错误设置", options: { format: "", header: "", lineEnding: "", jsonStructure: "", condition: "", nullText: "" } }]));
    expect(readTransferPresets()).toEqual([{ name: "错误设置", options: { nullText: "" } }]);
  });
  it("空名称不能保存，名称长度受限", () => {
    expect(() => saveTransferPreset("   ", defaultTransferOptions())).toThrow("请输入");
    expect(saveTransferPreset("名".repeat(80), defaultTransferOptions())[0].name).toHaveLength(40);
  });
});
