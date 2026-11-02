/**
 * NCC/BIP 报文解密（对齐上游 `NCCJsonDecodeDialog` 的算法，逐行核对过）。
 *
 * 密文格式：外层 base64 包着一段 **hex 文本**，hex 解出来才是 AES 密文。
 * 密钥：(crux + aesKey).substring(0, 32) 的 **base64 解码结果**（24 字节 = AES-192）。
 * 算法：AES/CTR/NoPadding，IV 固定 `db2139561c9fe068`（16 字节 ASCII）。
 * gzip：整体就是 base64(gzip 字节)。
 * cowboy：aesKey 本身被 cowboyAesKey（默认 `4fa8959db7b4423a99f056e299914128`）加密过，
 * 用它先解出真正的 aesKey。
 *
 * 全部走 WebCrypto / DecompressionStream（WebView2 与 Node 都有），不引额外依赖。
 */

/** 上游写死的 IV（`NCCJsonDecodeDialog.decrypt`）。 */
const IV = new TextEncoder().encode("db2139561c9fe068");

/** cowboy 密文的默认密钥（上游 `TEMP_COWBODYAESKEY`）。 */
export const DEFAULT_COWBOY_KEY = "4fa8959db7b4423a99f056e299914128";

export interface DecodeOptions {
  aes: boolean;
  gzip: boolean;
  pretty: boolean;
  aesKey: string;
  crux: string;
  cowboy: string;
  cowboyAesKey: string;
}

export interface DecodeResult {
  text: string;
  /** 每一步做了什么（换了 cowboy、JSON 格式化失败等），界面原样展示。 */
  notes: string[];
}

export function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function hexToBytes(s: string): Uint8Array<ArrayBuffer> {
  const t = s.trim();
  if (t.length === 0 || t.length % 2 !== 0 || /[^0-9a-f]/i.test(t)) {
    throw new Error("报文不是合法的十六进制：AES 密文应是「base64 包一层 hex 文本」");
  }
  const out = new Uint8Array(new ArrayBuffer(t.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(t.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** `(crux + aesKey).substring(0, 32)`；不足 32 位就是配置错了，直接报清楚。 */
export function deriveKey(aesKey: string, crux: string): string {
  const joined = crux + aesKey;
  if (joined.length < 32) {
    throw new Error(`(crux + aesKey) 只有 ${joined.length} 位，不足 32 位`);
  }
  return joined.slice(0, 32);
}

async function decryptAes(cryptoText: string, keyStr: string): Promise<string> {
  const keyBytes = b64ToBytes(keyStr);
  if (![16, 24, 32].includes(keyBytes.length)) {
    throw new Error(
      `AES 密钥 base64 解出来是 ${keyBytes.length} 字节，不是 16/24/32 字节（aesKey 应是 base64 串）`,
    );
  }
  const data = hexToBytes(new TextDecoder().decode(b64ToBytes(cryptoText)));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CTR", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CTR", counter: IV, length: 128 },
    key,
    data,
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    throw new Error("解密结果不是 UTF-8：密钥不对，或这段报文本来就没有加密");
  }
}

async function gunzipBase64(text: string): Promise<string> {
  const bytes = b64ToBytes(text);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * 按开关依次解密 / 解压 / 格式化。
 *
 * 顺序与上游一致：AES → gzip → JSON 美化。任一步失败都抛可读错误，不返回半截结果。
 */
export async function decodePayload(input: string, opts: DecodeOptions): Promise<DecodeResult> {
  const notes: string[] = [];
  let text = input.trim();
  if (!text) throw new Error("请先粘贴报文");

  if (opts.aes) {
    let aesKey = opts.aesKey.trim();
    const cowboy = opts.cowboy.trim();
    if (!aesKey && cowboy) {
      const cowboyKey = opts.cowboyAesKey.trim() || DEFAULT_COWBOY_KEY;
      const plain = await decryptAes(cowboy, cowboyKey);
      aesKey = plain.trim();
      notes.push(`已用 cowboy 密文换算出 aesKey：${aesKey}`);
    }
    if (!aesKey) throw new Error("没有 AES 密钥：填 aesKey，或填 cowboy 密文自动换算");
    text = await decryptAes(text, deriveKey(aesKey, opts.crux.trim()));
  }

  if (opts.gzip) text = await gunzipBase64(text);

  if (opts.pretty) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      notes.push("结果不是合法 JSON，已原样显示");
    }
  }
  return { text, notes };
}
