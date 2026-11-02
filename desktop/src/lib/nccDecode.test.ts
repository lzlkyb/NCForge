import { describe, expect, it } from "vitest";
import {
  DEFAULT_COWBOY_KEY,
  b64ToBytes,
  decodePayload,
  deriveKey,
  hexToBytes,
} from "./nccDecode";

/**
 * 向量由 `scripts/tmp-ncc-vector.mjs`（Node crypto，与 Java SunJCE 同算法）生成后固定在这里：
 * 算法一旦被改坏（IV、hex 外层、crux 拼接）这里必红。
 */
const CRUX = "1234567890abcdef";
const AES_KEY = "9b645baa78cf41e180e4751abc46d6c2";
const PLAIN = '{"name":"测试","n":1,"nested":{"ok":true}}';
const PAYLOAD =
  "YmFkY2QzZDJmNDExOTg3NmNlMTVjYTBkMjFhYWRlYzYyNjJjODZkZjAzZWVhMWQ4MzkxMWZkNGM1Y2Q4ODc2YzU3Nzg0YjdjYzBhMjc5NTcyOGJlOTIxMw==";
const COWBOY =
  "ZTJkZDYyYzE0ZjdkYmRjN2JmODFlOWIxMjJlOWQ0NmU2OTBlYTExYzU1ODViOWQ2ODc2Yjk4NmQ5YzMyZGMwYw==";
const GZIP =
  "H4sIAAAAAAACCqtWykvMTVWyUnq2tfvF+qlKOkp5SlaGOkp5qcUlqSlKVtVK+dlKViVFpam1tQA7rC5XLAAAAA==";

const baseOptions = {
  aes: false,
  gzip: false,
  pretty: false,
  aesKey: "",
  crux: "",
  cowboy: "",
  cowboyAesKey: DEFAULT_COWBOY_KEY,
};

describe("NCC 报文解密", () => {
  it("AES/CTR 解出报文（base64 包 hex 文本）", async () => {
    const r = await decodePayload(PAYLOAD, { ...baseOptions, aes: true, aesKey: AES_KEY, crux: CRUX });
    expect(r.text).toBe(PLAIN);
  });

  it("crux 参与密钥拼接", async () => {
    expect(deriveKey(AES_KEY, CRUX)).toBe("1234567890abcdef9b645baa78cf41e1");
    // 换 crux 就必须解不出来（除非解码恰好是 UTF-8，这里用抛错断言）
    await expect(
      decodePayload(PAYLOAD, { ...baseOptions, aes: true, aesKey: AES_KEY, crux: "ffffffffffffffff" }),
    ).rejects.toThrow(/不是 UTF-8/);
  });

  it("cowboy 密文换算出 aesKey 后继续解密", async () => {
    const r = await decodePayload(PAYLOAD, {
      ...baseOptions,
      aes: true,
      aesKey: "",
      crux: CRUX,
      cowboy: COWBOY,
    });
    expect(r.text).toBe(PLAIN);
    expect(r.notes.join()).toContain(`aesKey：${AES_KEY}`);
  });

  it("gzip 单独解压（base64 → gunzip）", async () => {
    const r = await decodePayload(GZIP, { ...baseOptions, gzip: true });
    expect(r.text).toBe(PLAIN);
  });

  it("JSON 美化按 2 空格缩进，非 JSON 原样返回并留提示", async () => {
    const pretty = await decodePayload('{"a":1}', { ...baseOptions, pretty: true });
    expect(pretty.text).toBe('{\n  "a": 1\n}');
    const raw = await decodePayload("not json", { ...baseOptions, pretty: true });
    expect(raw.text).toBe("not json");
    expect(raw.notes.length).toBe(1);
  });

  it("缺少 aesKey 时明确报错而不是返回密文", async () => {
    await expect(decodePayload(PAYLOAD, { ...baseOptions, aes: true })).rejects.toThrow(/aesKey/);
  });

  it("空报文拒绝", async () => {
    await expect(decodePayload("   ", baseOptions)).rejects.toThrow(/粘贴报文/);
  });

  it("hex 层校验拒绝奇数和非法字符", () => {
    expect(() => hexToBytes("abc")).toThrow(/十六进制/);
    expect(() => hexToBytes("zz")).toThrow(/十六进制/);
    expect(() => hexToBytes("")).toThrow(/十六进制/);
    expect([...hexToBytes("0aFF")]).toEqual([10, 255]);
  });

  it("base64 解出来的密钥长度非法时报错", async () => {
    // 32 个 base64 字符 + 尾部 "==" 只解出 22 字节，不是 AES 合法密钥长度
    const badKey = "abcdefghijklmnopqrstuvwxyzABCD==";
    expect(badKey.length).toBe(32);
    expect(b64ToBytes(badKey).length).toBe(22);
    await expect(
      decodePayload(PAYLOAD, { ...baseOptions, aes: true, aesKey: badKey }),
    ).rejects.toThrow(/16\/24\/32/);
  });

  it("deriveKey 不足 32 位时报错", () => {
    expect(() => deriveKey("short", "")).toThrow(/不足 32 位/);
  });

  it("b64ToBytes 忽略换行", () => {
    expect([...b64ToBytes("aGVs\nbG8=")]).toEqual([...new TextEncoder().encode("hello")]);
  });
});
