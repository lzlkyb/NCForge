/**
 * 代码区改动块（相对 SVN 基线）。纯函数，不 import Monaco / Tauri —— 单测直接喂文本。
 *
 * 口径（改之前先看方案 §6 A1 / §9）：
 * - 比较的是 SVN BASE 与「当前编辑器模型内容」，所以已保存与未保存改动都算在内。
 * - `svn_diff` 的 baseText 可能带 CRLF / MIXED 换行，Monaco model 一律 LF；
 *   不做归一时 CRLF 文件每行都多一个 `\r`，整篇会被算成假差异。
 * - 行号一律按「行」算，不按字节偏移：混合换行文件（NC 实测 2.2%）行号仍对齐。
 * - 超过 `textDiff` 的 4000 行/侧上限直接不画（tooBig），界面给一句提示。
 * - BASE 为空 = 新增文件（未纳管或 svn add），整篇算新增；不能走通用 diff，
 *   否则空文本 split("\n") 得到的一行 "" 会变成一条假的删除。
 */
import { diffLines, type DiffRow } from "./textDiff";

/** 一处连续的改动。行号都是 1 基。 */
export interface ChangedBlock {
  /** 新侧（编辑器）行区间，闭区间。纯删除块没有新侧行：endLine = startLine - 1，startLine 是插入点。 */
  startLine: number;
  endLine: number;
  /** 基线侧行区间，闭区间；纯新增块为 0。 */
  oldStart: number;
  oldEnd: number;
  added: number;
  removed: number;
  /** 基线这一块原文（LF 归一后按行拆），浮层展示与写回都用它。 */
  baseLines: string[];
  /** 当前这一块原文；空数组 = 纯删除。 */
  currentLines: string[];
  /** 删除三角挂在新侧哪一行；0 = 这一块没有删除。 */
  deletedAt: number;
}

export interface ChangedSnapshot {
  blocks: ChangedBlock[];
  added: number;
  removed: number;
  tooBig: boolean;
  /** 新增/替换行的新侧行号（色条画在这些行）。 */
  addedLines: number[];
  /** 删除标记所在行。 */
  deletedLines: number[];
  /** 改动区内的所有行，D1 与编译错误求交用它。 */
  touchedLines: number[];
}

export const EMPTY_CHANGED: ChangedSnapshot = Object.freeze({
  blocks: [],
  added: 0,
  removed: 0,
  tooBig: false,
  addedLines: [],
  deletedLines: [],
  touchedLines: [],
});

/** 把 CRLF / CR 归一成 LF。Monaco 保存时会按文件原换行还原，这里只影响比较。 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function wholeFileAdded(current: string): ChangedSnapshot {
  const lines = current.split("\n");
  if (lines.length === 1 && lines[0] === "") return EMPTY_CHANGED;
  const addedLines = lines.map((_, i) => i + 1);
  const block: ChangedBlock = {
    startLine: 1,
    endLine: lines.length,
    oldStart: 0,
    oldEnd: 0,
    added: lines.length,
    removed: 0,
    baseLines: [],
    currentLines: lines,
    deletedAt: 0,
  };
  return {
    blocks: [block],
    added: lines.length,
    removed: 0,
    tooBig: false,
    addedLines,
    deletedLines: [],
    touchedLines: addedLines,
  };
}

/**
 * 算一个文件相对基线的改动块。输入可以是任意文本，调用方负责给对基线。
 * 返回值是稳定的新对象（内容没变时调用方自行用 lastInput 比较，避免重复渲染）。
 */
export function computeChanged(baseText: string, currentText: string): ChangedSnapshot {
  const base = normalizeEol(baseText);
  const current = normalizeEol(currentText);
  if (base === "") return wholeFileAdded(current);
  const result = diffLines(base, current);
  if (result.tooBig) return { ...EMPTY_CHANGED, tooBig: true };
  // current 已归一成 LF，split 的行数与 Monaco getLineCount 一致（含末尾空行）
  const currentLineCount = current.split("\n").length;

  const rows = result.rows;
  const blocks: ChangedBlock[] = [];
  const addedLines: number[] = [];
  const deletedLines: number[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  while (i < rows.length) {
    if (rows[i].op === "same") {
      i += 1;
      continue;
    }
    // 连续非 same 行合成一块。纯删除块没有新侧行号，用前一个 same 行的新行号当锚点。
    const anchorNew = i > 0 ? rows[i - 1].newLine ?? 0 : 0;
    const anchorOld = i > 0 ? rows[i - 1].oldLine ?? 0 : 0;
    const baseLines: string[] = [];
    const currentLines: string[] = [];
    let firstNew = 0;
    let lastNew = 0;
    let firstOld = 0;
    let lastOld = 0;
    while (i < rows.length && rows[i].op !== "same") {
      const r: DiffRow = rows[i];
      if (r.op === "del") {
        baseLines.push(r.text);
        if (!firstOld) firstOld = r.oldLine ?? anchorOld + 1;
        lastOld = r.oldLine ?? lastOld;
      } else {
        const line = r.newLine ?? anchorNew + 1;
        currentLines.push(r.text);
        if (!firstNew) firstNew = line;
        lastNew = line;
        addedLines.push(line);
      }
      i += 1;
    }
    const startLine = firstNew || anchorNew + 1;
    const endLine = firstNew ? lastNew : anchorNew;
    const del = baseLines.length;
    const add = currentLines.length;
    added += add;
    removed += del;
    // 纯删除块锚在「下一个新侧行」，删到文件尾时那个行号是 行数+1：
    // Monaco 的 range 越界会整批丢装饰（甚至抛错）。按当前行数收敛到末行，
    // 删除三角仍落在删除位置的紧邻行，浮层与写回用的 baseLines 不受影响。
    const deletedAt = del > 0 ? Math.min(startLine, currentLineCount) : 0;
    if (deletedAt > 0) deletedLines.push(deletedAt);
    blocks.push({
      startLine,
      endLine,
      oldStart: firstOld || anchorOld + 1,
      oldEnd: lastOld || anchorOld,
      added: add,
      removed: del,
      baseLines,
      currentLines,
      deletedAt,
    });
  }
  const touchedLines = [...new Set([...addedLines, ...deletedLines])].sort((a, b) => a - b);
  return { blocks, added, removed, tooBig: false, addedLines, deletedLines, touchedLines };
}

/** 色条/删除三角被点到时，按行号找回它属于哪一块。 */
export function blockAtLine(snap: ChangedSnapshot, line: number): ChangedBlock | undefined {
  return snap.blocks.find((b) => {
    const lo = Math.min(b.startLine, b.deletedAt || b.startLine);
    const hi = Math.max(b.endLine, b.deletedAt);
    return line >= lo && line <= hi;
  });
}

/**
 * 块内容指纹：不含新侧行号（开浮层后插一行行号会变，已审状态不该跟着丢），
 * 含基线行号，避免同一段文本在文件多处出现时互相串味。
 */
export function blockFingerprint(b: ChangedBlock): string {
  return `${b.oldStart}-${b.oldEnd}|${b.baseLines.join("\u0000")}|${b.currentLines.join("\u0000")}`;
}

/** D1 用：这一行是否落在改动区内。touchedLines 有序，二分代替 includes（几千行 × 几百问题）。 */
export function isChangedLine(snap: ChangedSnapshot, line: number): boolean {
  const a = snap.touchedLines;
  let lo = 0;
  let hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] === line) return true;
    if (a[mid] < line) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}
