import { describe, expect, it, vi } from "vitest";
vi.mock("./monacoSetup", () => ({ monaco: {} }));
vi.mock("./langProviderContext", () => ({ context: vi.fn() }));
vi.mock("./lang", () => ({ langRequest: vi.fn(), langCapabilityEpoch: () => 1 }));
vi.mock("./editorPrefs", () => ({ getEditorPrefs: () => ({ inlayHints: false }) }));
vi.mock("./workspaceEpoch", () => ({ workspaceEpoch: () => 1 }));
import { javaCallArguments, signatureParameterNames } from "./javaParameterHints";

describe("旧JDT参数名提示适配", () => {
  it("从字符串和范围形式读取参数名", () => {
    expect(signatureParameterNames({ label: "load(String name, int count)", parameters: [{ label: [5, 16] }, { label: "int count" }] })).toEqual(["name", "count"]);
  });
  it("字符串、数组和嵌套调用内逗号不增加参数个数", () => {
    const text = 'load("a,b", new int[] {1, 2}, other(3, 4))';
    const calls = javaCallArguments(text, 0, text.length);
    expect(calls[0].arguments.map(at => text.slice(at, at + 5))).toEqual(['"a,b"', 'new i', 'other']);
    expect(calls[1].arguments).toHaveLength(2);
  });
  it("忽略声明与控制结构，并有单次上限", () => {
    expect(javaCallArguments("public void load(String value) {\n if (ready) {}", 0, 100)).toEqual([]);
    const text = Array.from({ length: 20 }, () => "load(1)").join(";");
    expect(javaCallArguments(text, 0, text.length)).toHaveLength(8);
  });
});
