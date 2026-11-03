import { fuzzyMatch, type FuzzyHit, type Range } from "./fuzzy";

/**
 * 中文首字母（不依赖词典）：GB2312 一级汉字区（0xB0A1–0xD7F9）本身按拼音排序，
 * 用 23 个分界字把区段切成 A–Z，就能把「编译当前模块」映射成 `bydqmk`。
 * 只覆盖 3755 个常用字；生僻字不参与首字母匹配，退回原有模糊匹配。
 */
const BOUNDS = "啊芭擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝";
const LETTERS = "ABCDEFGHJKLMNOPQRSTWXYZ";

let table: Map<string, string> | null = null;

function buildTable(): Map<string, string> {
  const map = new Map<string, string>();
  let decoder: TextDecoder;
  try {
    // 旧版 WebView / 无完整 ICU 的运行时没有 gbk 解码器：直接放弃首字母，不影响其它搜索。
    decoder = new TextDecoder("gbk");
  } catch {
    return map;
  }
  let letter = "";
  for (let hi = 0xb0; hi <= 0xd7; hi++) {
    const last = hi === 0xd7 ? 0xf9 : 0xfe;
    for (let lo = 0xa1; lo <= last; lo++) {
      const ch = decoder.decode(Uint8Array.of(hi, lo));
      if (ch.length !== 1) continue;
      const at = BOUNDS.indexOf(ch);
      if (at >= 0) letter = LETTERS[at];
      if (letter) map.set(ch, letter);
    }
  }
  return map;
}

export interface Initials {
  /** 首字母串（小写，ASCII 字母数字原样保留，标点 / 空白跳过）。 */
  text: string;
  /** 首字母串第 i 位对应的原文下标。 */
  chars: number[];
  /** 是否含至少一个汉字（纯英文时没必要走首字母，原地模糊匹配更准）。 */
  hasHan: boolean;
}

const cache = new Map<string, Initials | null>();

export function pinyinInitials(text: string): Initials | null {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  table ??= buildTable();
  let out = "";
  const chars: number[] = [];
  let hasHan = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const initial = table.get(ch);
    if (initial) {
      out += initial.toLowerCase();
      chars.push(i);
      hasHan = true;
    } else if (/[a-z0-9]/i.test(ch)) {
      out += ch.toLowerCase();
      chars.push(i);
    }
  }
  const value = hasHan ? { text: out, chars, hasHan } : null;
  // 只用于命令标题 / 设置关键词这类小集合；上限防住意外的大量调用。
  if (cache.size > 500) cache.clear();
  cache.set(text, value);
  return value;
}

/** 查询至少含一个字母才可能是在打首字母（纯数字 / 中文直接走原文匹配）。 */
const LETTER_QUERY = /[a-z]/i;

/** 按首字母匹配，命中区间映射回原文（用于高亮）。 */
export function matchInitials(query: string, text: string): FuzzyHit | null {
  if (!LETTER_QUERY.test(query)) return null;
  const p = pinyinInitials(text);
  if (!p) return null;
  const hit = fuzzyMatch(query, p.text);
  if (!hit) return null;
  const ranges: Range[] = [];
  for (const [a, b] of hit.ranges) {
    const start = p.chars[a];
    const end = p.chars[b - 1] + 1;
    if (start === undefined || end === undefined) return null;
    const prev = ranges[ranges.length - 1];
    if (prev && prev[1] === start) prev[1] = end;
    else ranges.push([start, end]);
  }
  return { score: hit.score, ranges };
}

/** 原文模糊匹配与首字母匹配取更高分；两者都没有返回 null。 */
export function matchText(query: string, text: string): FuzzyHit | null {
  const direct = fuzzyMatch(query, text);
  const initials = matchInitials(query, text);
  if (!direct) return initials;
  if (!initials) return direct;
  return initials.score > direct.score ? initials : direct;
}
