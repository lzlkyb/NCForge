import type { Cell, ColumnMeta } from "./dbApi";
import { cellText, lobPreviewBody } from "./db";
import { fitsCell } from "./resultView";
import { isWideText } from "./wideText";

/**
 * 单元格里的「二次编码」识别与解码。
 *
 * 有些系统先把 JSON / XML 转成十六进制再塞进 CLOB（NC 的 `UAPBD_LOG_H.JSON`
 * 就是这样），查询结果里只能看到 `7B226F72…`。**这不是取值问题**——库里存的
 * 就是这串字符，CLOB 一个字节没丢——所以解码只做在显示层：原值、排序、筛选、
 * 复制、导出、写回一律不动。
 *
 * 判据必须保守。一串纯 hex 字符本身太常见了（MD5、流水号、`DEADBEEF` 这类
 * 常量、`12345678` 这种纯数字），解出来是乱码却当明文显示，比不解码更糟：
 * 用户会拿乱码去比对业务数据。所以自动识别只认两种落点——解出来是合法
 * JSON，或者 UTF-8 严格解码通过且像人写的内容。
 */

export type CodecKind = "hex" | "base64";
export type TextEncoding = "utf-8" | "gbk" | "gb18030";
export const binaryColumn = (type?: string) => /^(?:LONG\s+RAW|RAW|BLOB)(?:\b|\()/i.test(type?.trim() ?? "");
export const binaryPreview = (value: string) => /^(?:[\da-f]+…|<BLOB \d+B>)$/i.test(value.trim());

export interface Decoded {
  kind: CodecKind;
  /** 解码后的文本。 */
  text: string;
  encoding: TextEncoding;
  /** 解码出的字节数（不是原 hex 字符数）。 */
  bytes: number;
  /** false = 原串是奇数长度或来自截断的预览，末尾少了半个字节以上。 */
  complete: boolean;
  /** 解出来是合法 JSON。 */
  json: boolean;
}

const HEX_RE = /^[0-9a-f]+$/i;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 有没有 C0/C1 控制字符（保留 \t \n \r）。
 *
 * 不用正则写：字面控制字符会踩 `no-control-regex`，而且逐码位判断更清楚——
 * 解出这些字节说明原文是二进制，不是文本。
 */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) return true;
    if (c >= 127 && c <= 159) return true;
  }
  return false;
}

/** 手动解码的下限：4 个字节起。再短的话「abcdef」这种普通字符串也会冒出一个解码按钮。 */
const MIN_MANUAL = 8;
/** 自动识别的下限：32 个 hex 字符 = 16 字节，低于这个长度几乎不可能是 JSON/文本。 */
const MIN_AUTO = 32;
/** 列级识别：抽样行数、命中比例、最少非空值个数。 */
const SAMPLE_ROWS = 50;
const COLUMN_HIT_RATIO = 0.8;
const COLUMN_MIN_VALUES = 2;

function hexBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

function base64Bytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * 字节 → 文本。先严格 UTF-8，失败再试 GBK。
 *
 * GBK 解码器不会失败：任何字节都能"解"出字符，查不到就给 U+FFFD 或生僻字。
 * 所以这里只能靠「有没有替换字符」来判断，而调用方还要再叠加一层「像不像文本」。
 */
function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } | null {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    /* 不是 UTF-8，接着试 GBK */
  }
  try {
    const text = new TextDecoder("gbk", { fatal: false }).decode(bytes);
    if (!text.includes("\uFFFD")) return { text, encoding: "gbk" };
  } catch {
    /* 运行时裁掉了 GBK 表（精简 ICU），只能放弃 */
  }
  return null;
}

function looksLikeText(text: string): boolean {
  return text.length > 0 && !hasControlChar(text) && /\S/.test(text);
}

function isJsonText(text: string): boolean {
  const t = text.trim();
  if (t[0] !== "{" && t[0] !== "[") return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解一格。认不出来返回 null（调用方按原样显示）。
 *
 * `auto: true` 是网格自动识别用的严格模式；详情面板手动点「解码」用默认的宽松模式，
 * 允许 GBK 结果与短串，因为那是用户明确要求的，且面板上会标出编码与字节数。
 */
export function decodeCell(v: Cell, opts?: { auto?: boolean; binary?: boolean; encoding?: TextEncoding }): Decoded | null {
  if (typeof v !== "string") return null;
  const auto = opts?.auto ?? false;
  const source = v.trim();
  // 预览尾部的中文说明先剥掉，否则整串都判不成 hex。
  const body = lobPreviewBody(v).trim();
  const raw = opts?.binary && /^[\da-f]+…$/i.test(body) ? body.slice(0, -1) : body;
  if (raw.length < (opts?.binary ? 2 : auto ? MIN_AUTO : MIN_MANUAL)) return null;
  /** 来自 8K 预览 ⇒ 尾部本来就不全，解出来的文本可能缺最后几个字节。 */
  const fromPreview = raw.length !== source.length;

  let kind: CodecKind;
  if (HEX_RE.test(raw)) kind = "hex";
  else if (!opts?.binary && B64_RE.test(raw)) kind = "base64";
  else return null;

  const odd = kind === "hex" && raw.length % 2 !== 0;
  // 预览按字符截断，hex 会被切成奇数长度：丢掉最后半个字节，别让 parseInt 吃到 NaN。
  const bytes = kind === "hex" ? hexBytes(odd ? raw.slice(0, -1) : raw) : base64Bytes(raw);
  if (!bytes || bytes.length === 0) return null;

  const encoding = opts?.encoding ?? (opts?.binary && auto ? "utf-8" : undefined);
  let decoded;
  try {
    decoded = encoding ? { text: new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: fromPreview }), encoding } : decodeText(bytes);
  } catch { return null; }
  if (!decoded) return null;
  const json = isJsonText(decoded.text);
  if (json) {
    /* JSON 是最硬的证据，UTF-8 / GBK 都认 */
  } else if (auto) {
    // 自动识别只认 UTF-8：随机字节经 GBK 几乎总能"解"出两个生僻字，
    // 拿它当判据会把 MD5、流水号这些列一起误判成编码列。
    if (decoded.encoding !== "utf-8" || !looksLikeText(decoded.text)) return null;
  } else if (!looksLikeText(decoded.text)) {
    return null;
  }

  return {
    kind,
    text: decoded.text,
    encoding: decoded.encoding,
    bytes: bytes.length,
    complete: !fromPreview && !odd,
    json,
  };
}

/**
 * 带缓存的解码器。
 *
 * 网格每帧都要渲染可视行，滚动时同一格会被反复解码；一行日志表里重复值又特别多，
 * 按原串缓存能把开销压到可忽略。上限 4000 条，超出就不再增长（宁可重算也不吃内存）。
 */
export function memoDecoder(opts?: Parameters<typeof decodeCell>[1]): (v: Cell) => Decoded | null {
  const cache = new Map<string, Decoded | null>();
  return (v) => {
    if (typeof v !== "string") return null;
    const hit = cache.get(v);
    if (hit !== undefined) return hit;
    const decoded = decodeCell(v, opts);
    if (cache.size < 4000) cache.set(v, decoded);
    return decoded;
  };
}

/**
 * 扫一遍列，找出「整列都是编码」的列下标。
 *
 * 只抽样前 50 行并要求 80% 命中：单看一格容易误判，整列多数一致才可信。
 * 例外是**只有一个非空值**（`where 主键 = ?` 那种单行结果）——这时只有解出来是
 * 合法 JSON 才认，因为 JSON 是最硬的证据；否则一个恰好全 hex 的流水号就会被标成编码列。
 * 已经是预览的长值也能参与（尾部说明会剥掉）。
 */
export function detectEncodedColumns(
  columns: ColumnMeta[],
  rows: Cell[][],
  order: number[],
  sample = SAMPLE_ROWS,
): number[] {
  const limit = Math.min(order.length, sample);
  const found: number[] = [];
  if (!limit) return found;
  for (let c = 0; c < columns.length; c += 1) {
    let seen = 0;
    let hit = 0;
    /** 最后一个命中值是不是 JSON——单值场景下它就是「唯一那个」。 */
    let lastJson = false;
    for (let i = 0; i < limit; i += 1) {
      const v = rows[order[i]]?.[c];
      if (v === null || v === undefined || v === "") continue;
      seen += 1;
      const decoded = decodeCell(v, { auto: true });
      lastJson = decoded?.json ?? false;
      if (decoded) hit += 1;
      // 剩下的行全中也不够 80% 就没必要继续扫
      if (hit + (limit - i - 1) < seen * COLUMN_HIT_RATIO) break;
    }
    if (seen === 1 && hit === 1 && lastJson) found.push(c);
    else if (seen >= COLUMN_MIN_VALUES && hit / seen >= COLUMN_HIT_RATIO) found.push(c);
  }
  return found;
}

/** 网格里一格该显示什么：解出来就显示明文，否则原样（含 300 字截断）。 */
export function codedText(v: Cell, decoded: Decoded | null, max = 300): string {
  if (!decoded) return cellText(v, max);
  return decoded.text.length <= max ? decoded.text : `${decoded.text.slice(0, max)}…`;
}

/** 一行说明，详情面板与网格 title 共用。 */
export function describeDecoded(d: Decoded): string {
  const parts = [
    `${d.kind === "hex" ? "Hex" : "Base64"} 编码`,
    d.encoding.toUpperCase(),
    `${d.bytes} 字节`,
  ];
  if (d.json) parts.push("JSON");
  if (!d.complete) parts.push("末尾不完整");
  return parts.join(" · ");
}

/** 网格渲染要的三个答案：这列是不是编码列、开没开、这一格显示什么。 */
export interface GridCodec {
  /** 抽样判定「这一列是编码列」（还没开解码也算，用来出徽标）。 */
  encoded: (c: number) => boolean;
  /** 这一列当前是否按解码后的值显示。 */
  active: (c: number) => boolean;
  /** 一格该显示的文本。没开启解码就原样返回。 */
  text: (v: Cell, c: number, max?: number) => string;
  /** 一格解码后的值；没开启或认不出来返回 null。 */
  value: (v: Cell, c: number) => Decoded | null;
  /** 网格里的悬停提示（编码说明 / 字符数 / 被列宽挤掉的完整值）。 */
  title: (v: Cell, c: number, colWidth?: number) => string | undefined;
}

/**
 * 给网格用的解码上下文。
 *
 * `decodedNames` 是用户逐列开的开关（按列名，存进布局里）；`auto` 只用来出徽标，
 * 不直接改显示——默认不改用户的数，误判时至少还能一眼看出「这列被认成编码了」。
 */
export function gridCodec(
  columns: ColumnMeta[],
  rows: Cell[][],
  order: number[],
  decodedNames: string[],
  rawNames: string[] = [],
): GridCodec {
  const decode = memoDecoder();
  const decodeBinary = memoDecoder({ binary: true, auto: true });
  const decodeBinaryText = memoDecoder({ binary: true });
  const auto = new Set(detectEncodedColumns(columns, rows, order));
  const active = new Set(decodedNames);
  const raw = new Set(rawNames);
  const binary = (c: number) => binaryColumn(columns[c]?.type);
  const on = (c: number) => !raw.has(columns[c]?.name) && (active.has(columns[c]?.name) || binary(c));
  const value = (v: Cell, c: number) => !on(c) ? null : !binary(c) ? decode(v)
    : active.has(columns[c]?.name) ? decodeBinaryText(v) : decodeBinary(v);
  return {
    encoded: (c) => binary(c) || auto.has(c),
    active: on,
    value,
    text: (v, c, max) => codedText(v, value(v, c), max),
    title: (v, c, colWidth) => {
      const d = value(v, c);
      // 文案必须指向**真实入口**：双击在四家主流工具里都是编辑，写成「双击看完整值」
      // 就是骗人去点一个不办事的手势（2026-11-11 用户反馈的原始触发点之一）。
      if (d) return `${describeDecoded(d)} · 点格内「…」或按 F4 看完整值`;
      // 这里只看列级判定，不再逐格解码：title 是每帧对每个可见格都要算的，
      // 一帧上千次 hex 解析会把滚动拖卡。列级 80% 命中已经足够支撑这句提示。
      if (auto.has(c)) return "检测到十六进制/Base64 编码 · 右键列头可显示明文";
      if (isWideText(v)) return `${String(v).length} 字符 · 点格内「…」或按 F4 看完整值`;
      // 被列宽挤掉的值：悬停要给完整值，否则「显示不全」就没有第二条路。
      // 宽度判定走 `fitsCell`（带测量缓存），短值一次比较就能排除。
      if (colWidth !== undefined) {
        const text = cellText(v, 300);
        if (text && !fitsCell(text, colWidth)) {
          const full = typeof v === "string" ? v : String(v);
          return full.length > 500
            ? `${full.slice(0, 500)}…（共 ${full.length} 字符，按 F4 看完整值）`
            : `${full}（按 F4 看完整值）`;
        }
      }
      return undefined;
    },
  };
}

/** `hextoraw` 在 SQL 里的硬上限：参数 4000 字节 → RAW 2000 字节。 */
const SQL_HEXTORAW_LIMIT = 2000;

/**
 * 生成在 SQL 里解码的模板（C 方案）。
 *
 * 原 SQL 原样嵌进子查询，不猜表名和主键——外层只是把目标列换成解码表达式。
 * 单值超过 2000 字节时 `hextoraw` 会直接报错，模板里写明了这条限制。
 */
export function decodeSqlTemplate(sql: string, column: string): string {
  const quoted = column.replace(/"/g, '""');
  const ident = `"${quoted}"`;
  // 别名要整个加引号：`"json"_text` 是非法标识符，`"json_text"` 才是合法的。
  const alias = `"${quoted}_text"`;
  const inner = sql
    .trim()
    .replace(/;\s*$/, "")
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return [
    `-- 十六进制转文本。hextoraw 在 SQL 里最多吃 4000 个 hex 字符（${SQL_HEXTORAW_LIMIT} 字节），`,
    "-- 原文更长的值这条会报 ORA-06502，请改用网格里的解码显示（不受此限）。",
    `select t.*, utl_raw.cast_to_varchar2(hextoraw(t.${ident})) as ${alias}`,
    "  from (",
    inner,
    "  ) t",
  ].join("\n");
}
