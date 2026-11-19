/**
 * upm 装配清单 → 大纲符号（P2-6 文件摘要）。
 *
 * 解析真源在 Rust `nc_upm::parse`（`nc_upm_file` 命令），这里只做一件事：
 * 给每条装配找到它在**当前编辑器文本**里的位置，变成可点击跳转的符号。
 * 后端解析不带行号，所以位置靠文本配对：按文档顺序扫 `<component>` 块，
 * 与解析出的组件逐一对上（接口名 + 实现名都按 parse 的 trim 口径比较）。
 *
 * 口径约束（与 Rust 侧保持一致，改一边必须改另一边）：
 * - 注释先中和成等长空白（偏移不漂移）；未闭合注释之后全部作废——
 *   `strip_comments` 就是这么截断的；
 * - 组件在 `</component>`、下一个 `<component>` 或文末处收尾（脏数据不丢）；
 * - 标签名大小写不敏感；接口/实现取标签内文本并 trim。
 */
import type { FlatSymbol } from "./symbols";
import type { UpmFile } from "./upm";
import { ncKinds } from "./ncDeclarationOutline";

const shortName = (cls: string) => cls.slice(cls.lastIndexOf(".") + 1);

/** 注释 → 等长空白（**换行保留**，否则多行注释后的行号全漂移）。
 * 未闭合注释之后全作废（与 `nc_upm::strip_comments` 同口径）。 */
export function blankComments(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let out = "";
  let rest = text;
  for (;;) {
    const i = rest.indexOf("<!--");
    if (i < 0) return out + rest;
    out += rest.slice(0, i);
    const j = rest.indexOf("-->", i + 4);
    if (j < 0) return out + blank(rest.slice(i));
    out += blank(rest.slice(i, j + 3));
    rest = rest.slice(j + 3);
  }
}

interface Block {
  /** 块起点（`<component` 的 `<`）。 */
  start: number;
  /** 块终点（不含）：闭标签末尾 / 下一个开标签 / 文末。 */
  end: number;
  iface: string;
  impl: string;
  /** 接口名文本的绝对偏移（找不到接口时为 -1）。 */
  ifaceAt: number;
  implAt: number;
}

const IFACE = /(<interface\b[^>]*>)([^<]*)(<\/interface>)/i;
const IMPL = /(<implementation\b[^>]*>)([^<]*)(<\/implementation>)/i;

/** 按文档顺序扫组件块。块边界与 Rust Builder 的 push 时机一致。 */
function blocksOf(clean: string): Block[] {
  const out: Block[] = [];
  const openRe = /<component\b[^>]*>/gi;
  const opens: number[] = [];
  for (const m of clean.matchAll(openRe)) opens.push(m.index);
  for (let i = 0; i < opens.length; i++) {
    const start = opens[i];
    const closeRe = /<\/component\s*>/gi;
    closeRe.lastIndex = start;
    const close = closeRe.exec(clean);
    const next = opens[i + 1] ?? clean.length;
    const end = close && close.index < next ? close.index + close[0].length : next;
    const body = clean.slice(start, end);
    const mi = IFACE.exec(body);
    const mm = IMPL.exec(body);
    const contentAt = (m: RegExpExecArray | null) => {
      if (!m) return -1;
      const lead = m[2].length - m[2].trimStart().length;
      return start + m.index + m[1].length + lead;
    };
    out.push({
      start, end,
      iface: mi ? mi[2].trim() : "",
      impl: mm ? mm[2].trim() : "",
      ifaceAt: contentAt(mi),
      implAt: contentAt(mm),
    });
  }
  return out;
}

/**
 * 装配清单 + 当前文本 → 符号列表。
 * 名字取接口短名（跳转落点在接口文本上），container 是实现短名（筛选/提示用）；
 * 只有实现没有接口的脏数据反过来。配对不上的组件仍列出（第 1 行兜底），
 * 解析结果不因定位失败而丢条目。
 */
export function upmSymbols(file: UpmFile, text: string): FlatSymbol[] {
  const clean = blankComments(text);
  const blocks = blocksOf(clean);
  const lineStarts: number[] = [0];
  for (let i = 0; i < clean.length; i++) if (clean[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
  };
  const out: FlatSymbol[] = [];
  let bi = 0;
  for (const comp of file.components) {
    // 向前找第一个对得上的块：接口+实现全等优先，其次单字段相等（坏格式容忍）
    let found: Block | undefined;
    for (let k = bi; k < blocks.length; k++) {
      const b = blocks[k];
      const full = b.iface === comp.interface && b.impl === comp.implementation;
      const partial = (comp.interface !== "" && b.iface === comp.interface) ||
        (comp.interface === "" && comp.implementation !== "" && b.impl === comp.implementation);
      if (full || partial) { found = b; bi = k + 1; break; }
    }
    const name = shortName(comp.interface || comp.implementation);
    const implShort = shortName(comp.implementation);
    const anchor = found ? (found.ifaceAt >= 0 ? found.ifaceAt : found.implAt) : -1;
    const pos = anchor >= 0 ? lineAt(anchor) : { line: 1, column: 1 };
    const start = found ? lineAt(found.start).line : pos.line;
    const end = found ? lineAt(Math.max(found.start, found.end - 1)).line : pos.line;
    out.push({
      name,
      kind: comp.visibility === "private" ? ncKinds.privateComponent : ncKinds.component,
      container: implShort && implShort !== name ? implShort : "",
      line: pos.line, column: pos.column,
      startLine: start, endLine: end,
      depth: 1,
    });
  }
  return out;
}