import { describe, expect, it } from "vitest";
import {
  codedText,
  decodeCell,
  decodeSqlTemplate,
  describeDecoded,
  detectEncodedColumns,
  gridCodec,
  memoDecoder,
} from "./cellCodec";
import type { ColumnMeta } from "./dbApi";

/** `{"orgNo":"100789","page":1,"rows":1000}` 的 UTF-8 hex —— 真库 UAPBD_LOG_H.JSON 里就是这个形状。 */
const HEX_JSON =
  "7b226f72674e6f223a22313030373839222c2270616765223a312c22726f7773223a313030307d";
const PLAIN_JSON = '{"orgNo":"100789","page":1,"rows":1000}';
/** `{"名称":"物料","数量":12}` 的 GBK hex —— NC 库里中文更可能是这种。 */
const HEX_GBK_JSON = "7b22c3fbb3c6223a22ceefc1cf222c22cafdc1bf223a31327d";
/** `物料名称` 的 GBK hex —— 不是 JSON，只有手动解码才认。 */
const HEX_GBK_PHRASE = "ceefc1cfc3fbb3c6";
const B64_JSON = "eyJvcmdObyI6IjEwMDc4OSIsInBhZ2UiOjEsInJvd3MiOjEwMDB9";

const columns = (names: string[]): ColumnMeta[] =>
  names.map((name) => ({ name, type: "VARCHAR2", precision: 0, scale: 0 }));

describe("单元格编码识别", () => {
  it("LONG RAW 预览保留 UTF-8 正文和截断状态，普通列仍显示原串", () => {
    const preview = "7B226E616D65223A22E789A9E69699E4…";
    const meta = [{ ...columns(["INJSON"])[0], type: "LONG RAW" }, ...columns(["ID"])];
    const codec = gridCodec(meta, [[preview, preview]], [0], []);
    expect(codec.value(preview, 0)).toMatchObject({ text: '{"name":"物料', complete: false, json: false });
    expect(codec.text(preview, 1)).toBe(preview);
    expect(gridCodec(meta, [[preview]], [0], [], ["INJSON"]).text(preview, 0)).toBe(preview);
    expect(codec.text("000102FF", 0)).toBe("000102FF");
    expect(decodeCell(HEX_GBK_JSON, { binary: true, encoding: "gb18030" })?.text).toBe('{"名称":"物料","数量":12}');
  });
  it("hex 还原成 JSON 原文", () => {
    const d = decodeCell(HEX_JSON, { auto: true });
    expect(d?.text).toBe(PLAIN_JSON);
    expect(d?.kind).toBe("hex");
    expect(d?.encoding).toBe("utf-8");
    expect(d?.json).toBe(true);
    expect(d?.complete).toBe(true);
    expect(d?.bytes).toBe(39);
  });

  it("GBK 编码的中文 JSON 也能自动认出", () => {
    const d = decodeCell(HEX_GBK_JSON, { auto: true });
    expect(d?.encoding).toBe("gbk");
    expect(d?.text).toBe('{"名称":"物料","数量":12}');
    expect(d?.json).toBe(true);
  });

  it("纯数字、常量、哈希都不是编码", () => {
    for (const v of ["12345678", "DEADBEEF", "d41d8cd98f00b204e9800998ecf8427e"]) {
      expect(decodeCell(v, { auto: true }), v).toBeNull();
    }
  });

  it("太短的不猜", () => {
    expect(decodeCell("48656c6c6f", { auto: true })).toBeNull();
    expect(decodeCell("7b7d", { auto: true })).toBeNull();
  });

  it("GBK 短语只在手动解码时出现", () => {
    expect(decodeCell(HEX_GBK_PHRASE, { auto: true })).toBeNull();
    const manual = decodeCell(HEX_GBK_PHRASE);
    expect(manual?.text).toBe("物料名称");
    expect(manual?.encoding).toBe("gbk");
  });

  it("预览尾部的中文说明先剥掉，并标为不完整", () => {
    const preview = `${HEX_JSON} …（共 39 个字符，只显示前 8192，点「加载完整值」查看）`;
    const d = decodeCell(preview, { auto: true });
    expect(d?.text).toBe(PLAIN_JSON);
    expect(d?.complete).toBe(false);
  });

  it("奇数长度丢掉最后半个字节", () => {
    const d = decodeCell(`${HEX_JSON.slice(0, -1)}"`, { auto: true });
    expect(d).toBeNull();
    // 不加引号时是合法 hex 但长度奇数：截到偶数，complete=false
    const odd = decodeCell(HEX_JSON.slice(0, -1));
    expect(odd?.complete).toBe(false);
    expect(odd?.text.startsWith("{")).toBe(true);
  });

  it("base64 也认", () => {
    const d = decodeCell(B64_JSON, { auto: true });
    expect(d?.kind).toBe("base64");
    expect(d?.text).toBe(PLAIN_JSON);
  });

  it("普通文本、NULL、数字原样返回 null", () => {
    expect(decodeCell("这是一段普通中文")).toBeNull();
    expect(decodeCell(null)).toBeNull();
    expect(decodeCell(128)).toBeNull();
    expect(decodeCell("")).toBeNull();
  });

  it("列级识别按多数表决，只挑出编码列", () => {
    const meta = columns(["ID", "JSON", "MEMO"]);
    const rows = [
      ["1", HEX_JSON, "普通说明"],
      ["2", HEX_JSON, null],
      ["3", HEX_JSON, "另一条说明"],
      ["4", null, ""],
    ];
    expect(detectEncodedColumns(meta, rows, [0, 1, 2, 3])).toEqual([1]);
  });

  it("单行结果（where 主键）也能认，但只认 JSON", () => {
    const meta = columns(["JSON", "TEXT"]);
    const hexOf = (s: string) =>
      [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
    // 一行、解出来是 JSON ⇒ 认
    expect(detectEncodedColumns(meta, [[HEX_JSON, "1"]], [0])).toEqual([0]);
    // 一行、解出来是普通 UTF-8 文本但不是 JSON ⇒ 不猜（单值证据不够）
    const plain = hexOf("这是一段普通的中文说明文字，不是 JSON 结构，长度足够触发自动识别");
    expect(detectEncodedColumns(meta, [["1", plain]], [0])).toEqual([]);
    // 同样的值出现两次 ⇒ 列级多数成立，认
    expect(detectEncodedColumns(meta, [["1", plain], ["2", plain]], [0, 1])).toEqual([1]);
  });

  it("整列都是随机 hex 时不认（解不出文本）", () => {
    const meta = columns(["HASH"]);
    const hash = "d41d8cd98f00b204e9800998ecf8427e";
    const rows = [[hash], [hash], [hash]];
    expect(detectEncodedColumns(meta, rows, [0, 1, 2])).toEqual([]);
  });

  it("缓存解码器对同一串只算一次", () => {
    const decode = memoDecoder();
    const first = decode(HEX_JSON);
    const second = decode(HEX_JSON);
    expect(second).toBe(first);
    expect(second?.text).toBe(PLAIN_JSON);
  });
});

describe("解码后的显示", () => {
  it("有解码值就显示明文，超长再截断", () => {
    const d = decodeCell(HEX_JSON, { auto: true });
    expect(codedText(HEX_JSON, d)).toBe(PLAIN_JSON);
    expect(codedText(HEX_JSON, d, 10)).toBe('{"orgNo":"…');
    // 没有解码值就回退成原值显示（含 NULL）
    expect(codedText(HEX_JSON, null, 8)).toBe("7b226f72…");
    expect(codedText(null, null)).toBe("NULL");
  });

  it("说明文案带编码、字符集、字节数", () => {
    const d = decodeCell(HEX_JSON, { auto: true });
    expect(describeDecoded(d!)).toBe("Hex 编码 · UTF-8 · 39 字节 · JSON");
  });
});

describe("SQL 解码模板", () => {
  it("包住原 SQL，只把目标列换成解码表达式", () => {
    const sql = "select * from UAPBD_LOG_H where PK_HEAD='1001A110000002WWKTGP';";
    const out = decodeSqlTemplate(sql, "json");
    expect(out).toContain('utl_raw.cast_to_varchar2(hextoraw(t."json")) as "json_text"');
    expect(out).toContain("select * from UAPBD_LOG_H where PK_HEAD='1001A110000002WWKTGP'");
    expect(out).not.toContain(";");
  });

  it("列名里的双引号要转义，别名整体加引号", () => {
    const out = decodeSqlTemplate("select 1 from dual", 'we"ird');
    expect(out).toContain('t."we""ird"');
    expect(out).toContain('as "we""ird_text"');
  });
});
