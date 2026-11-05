import { describe, expect, it, vi } from "vitest";

// 纯函数测试跑在 node 环境：monaco 的 ESM 在导入期就摸 window，必须先挡掉。
const mocks = vi.hoisted(() => ({ register: vi.fn(), invoke: vi.fn(), session: 1 }));
vi.mock("./monacoSetup", () => ({ monaco: { languages: { registerDocumentSemanticTokensProvider: mocks.register } } }));
vi.mock("./editorStore", () => ({ pathOfModel: () => "C:/workspace/Demo.java" }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));
vi.mock("./lang", () => ({
  inLangModule: () => true,
  langReady: () => true,
  langCapabilityEpoch: () => mocks.session,
  onLangReadyChange: (cb: (ready: boolean) => void) => cb(true),
  flushDoc: async () => {},
  langRequest: async () => ({ tokenTypes: ["property", "type", "variable"], tokenModifiers: ["static", "readonly", "deprecated"] }),
}));

import {
  DEPRECATED_TOKEN_TYPE,
  deprecatedBit,
  markDeprecated,
  initSemanticTokens,
  parseLegend,
  toTokenData,
} from "./semanticTokens";

describe("语义 token 流解码", () => {
  it("合法的 5 元组增量流原样搬给 Monaco", () => {
    const data = toTokenData([0, 0, 9, 7, 0, 1, 4, 5, 14, 2]);
    expect(data).not.toBeNull();
    expect([...(data as Uint32Array)]).toEqual([0, 0, 9, 7, 0, 1, 4, 5, 14, 2]);
  });

  it("空流是合法的（文件里没有任何名字）", () => {
    expect(toTokenData([])?.length).toBe(0);
  });

  it("长度不是 5 的倍数整份丢弃", () => {
    expect(toTokenData([0, 0, 3, 7])).toBeNull();
    expect(toTokenData([0, 0, 3, 7, 0, 1])).toBeNull();
  });

  it("非数组 / 非整数 / 负数 / 超出 u32 → null", () => {
    expect(toTokenData("0,0,3,7,0")).toBeNull();
    expect(toTokenData([0, 0, 3, 7.5, 0])).toBeNull();
    expect(toTokenData([0, -1, 3, 7, 0])).toBeNull();
    expect(toTokenData([0, 0, 3, "7", 0])).toBeNull();
    expect(toTokenData([0, 0, 3, 7, 0x1_0000_0000])).toBeNull();
  });

  it("长度为 0 的 token 非法（Monaco 会告警）", () => {
    expect(toTokenData([0, 4, 0, 7, 0])).toBeNull();
  });
});

describe("legend 与 deprecated 修饰", () => {
  it("校验形状并追加 deprecated 类型（主题规则按类型名匹配）", () => {
    const l = parseLegend({ tokenTypes: ["type"], tokenModifiers: ["static", "deprecated"] });
    expect(DEPRECATED_TOKEN_TYPE).toBe("deprecated");
    expect(l).toEqual({ tokenTypes: ["type", "deprecated"], tokenModifiers: ["static", "deprecated"] });
  });

  it("缺字段 / 类型不对 / tokenTypes 为空 → null", () => {
    expect(parseLegend(null)).toBeNull();
    expect(parseLegend({ tokenTypes: ["type"] })).toBeNull();
    expect(parseLegend({ tokenTypes: ["type", 1], tokenModifiers: [] })).toBeNull();
    expect(parseLegend({ tokenTypes: [], tokenModifiers: [] })).toBeNull();
  });

  it("deprecated 位按 legend 顺序算；没有这个修饰符就是 0", () => {
    const l = parseLegend({ tokenTypes: ["type"], tokenModifiers: ["static", "readonly", "deprecated"] });
    expect(deprecatedBit(l as NonNullable<typeof l>)).toBe(4);
    const noDep = parseLegend({ tokenTypes: ["type"], tokenModifiers: ["static"] });
    expect(deprecatedBit(noDep as NonNullable<typeof noDep>)).toBe(0);
  });

  it("只把带该位的 token 换成附加类型，修饰位原样保留", () => {
    const l = parseLegend({ tokenTypes: ["function"], tokenModifiers: ["deprecated"] });
    const data = toTokenData([0, 0, 3, 0, 0, 1, 4, 5, 0, 1]) as Uint32Array;
    // 第一枚不带 deprecated，第二枚带
    markDeprecated(data, deprecatedBit(l as NonNullable<typeof l>), 1);
    expect([...data]).toEqual([0, 0, 3, 0, 0, 1, 4, 5, 1, 1]);
  });

  it("legend 里没有 deprecated 时什么都不改", () => {
    const data = toTokenData([0, 0, 3, 0, 1]) as Uint32Array;
    markDeprecated(data, 0, 9);
    expect(data[3]).toBe(0);
  });
});


it("常量保留独立样式，编辑或语言服务切换后的旧结果不会着色", async () => {
  let version = 1;
  const model = { getVersionId: () => version, isDisposed: () => false };
  const cancel = { isCancellationRequested: false };
  initSemanticTokens();
  await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledOnce());
  const provider = mocks.register.mock.calls[0][1];
  const types: string[] = provider.getLegend().tokenTypes;
  const tokens = { data: [0, 0, 4, 0, 3, 0, 6, 4, 0, 1, 0, 6, 4, 0, 7] };
  mocks.invoke.mockImplementationOnce(async () => { version++; return tokens; });
  expect(await provider.provideDocumentSemanticTokens(model, null, cancel)).toBeNull();
  mocks.invoke.mockImplementationOnce(async () => { mocks.session++; return tokens; });
  expect(await provider.provideDocumentSemanticTokens(model, null, cancel)).toBeNull();
  mocks.invoke.mockResolvedValueOnce(tokens);
  const result = await provider.provideDocumentSemanticTokens(model, null, cancel);
  expect([types[result.data[3]], types[result.data[8]], types[result.data[13]]]).toEqual([
    "nc-java-constant", "nc-java-property", "nc-java-deprecated",
  ]);
});
