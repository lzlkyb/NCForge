// 重命名用的纯函数：编辑清单的分组与文本应用。
//
// 单独一个文件是为了**不把 Monaco 拖进 node 单测**：重命名要改 model，所以另一半
// （`renameSymbol.ts`）必须 import editorStore → monacoSetup，一旦这些纯函数跟着它，
// 单测环境没有 `window`，整个测试文件起不来。这条和 db 那边的笔记是同一个坑。
import { uriToPath } from "./langConvert";

export interface LspPos {
  line: number;
  character: number;
}

export interface LspTextEdit {
  range: { start: LspPos; end: LspPos };
  newText: string;
}

/** 一个文件里的全部编辑（LSP 的 uri 已经由后端换回真实路径）。 */
export interface RenameGroup {
  path: string;
  edits: LspTextEdit[];
}

export interface RenamePlan {
  newName: string;
  groups: RenameGroup[];
  /** 动不了的目标（jar 里的类：只读，写不进去）。列出来让人知道这不是漏改。 */
  skipped: string[];
}

export interface RenameResult {
  /** 直接写盘的文件数。 */
  written: number;
  /** 只在编辑器里改了、还没保存的文件数。 */
  inEditor: number;
  /**
   * 因为标签只读（混合换行 / 编码有损 / jar 内虚拟文件）而跳过的文件。
   *
   * 这些文件里的符号引用没有改名——必须让人知道，否则工程会停在「改了一半」的状态。
   */
  skippedReadOnly: string[];
}

const posOf = (uri: string): string | null => {
  // 正常情况后端已经把影子 URI 换回真实路径了；仍然接受 file:// 形态，免得换实现就坏
  if (uri.startsWith("file://")) return uriToPath(uri);
  if (uri.startsWith("jdt://")) return null;
  return uri;
};

/** `WorkspaceEdit` → 按文件分组。两种形态（`changes` / `documentChanges`）都认。 */
export function groupEdits(result: unknown): { groups: RenameGroup[]; skipped: string[] } {
  const raw = result as {
    changes?: Record<string, LspTextEdit[]>;
    documentChanges?: { textDocument: { uri: string }; edits: LspTextEdit[] }[];
  } | null;
  const byPath = new Map<string, LspTextEdit[]>();
  const skipped: string[] = [];
  const add = (uri: string, edits: LspTextEdit[]) => {
    const path = posOf(uri);
    if (!path) {
      if (!skipped.includes(uri)) skipped.push(uri);
      return;
    }
    // 大小写不同视为同一个文件（Windows 盘符与目录名经常大小写不一致）
    const key = [...byPath.keys()].find((k) => k.toLowerCase() === path.toLowerCase()) ?? path;
    byPath.set(key, [...(byPath.get(key) ?? []), ...edits]);
  };
  for (const [uri, edits] of Object.entries(raw?.changes ?? {})) add(uri, edits ?? []);
  for (const d of raw?.documentChanges ?? []) add(d.textDocument.uri, d.edits ?? []);
  return {
    groups: [...byPath.entries()].map(([path, edits]) => ({ path, edits })).filter((g) => g.edits.length > 0),
    skipped,
  };
}

/**
 * 把 LSP 编辑应用到一段文本上。
 *
 * 从**后往前**改：每个编辑的行列都是相对原文算的，正着改会让后面的偏移全部错位。
 *
 * **越界或重叠一律抛错，不做就近夹取**：清单与磁盘文本对不上时（索引略旧、
 * 文件在别的程序里被改过），把行列夹到文件末尾会改写无关字符；重叠时丢掉一条
 * 则留下「一半改名、一半旧名」的工程。两种情况都应当整体中止，让人重试。
 */
export function applyLspEdits(text: string, edits: LspTextEdit[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  /** 该行内容长度（不含行尾的 \r\n / \n）。 */
  const lineLen = (line: number): number => {
    const start = starts[line];
    const end = line + 1 < starts.length ? starts[line + 1] : text.length;
    let len = end - start;
    while (len > 0 && (text[start + len - 1] === "\n" || text[start + len - 1] === "\r")) len -= 1;
    return len;
  };
  const pos = (p: LspPos, what: string): number => {
    if (p.line < 0 || p.line >= starts.length) {
      throw new Error(`编辑位置越界（${what} 行 ${p.line + 1}，文件只有 ${starts.length} 行），已中止`);
    }
    if (p.character < 0 || p.character > lineLen(p.line)) {
      throw new Error(`编辑位置越界（${what} 行 ${p.line + 1} 列 ${p.character + 1}），已中止`);
    }
    return starts[p.line] + p.character;
  };
  const list = edits
    .map((e) => ({ start: pos(e.range.start, "起点"), end: pos(e.range.end, "终点"), text: e.newText }))
    // 起点晚于终点是空/反向区间（LSP 允许），不产生改动；越界在上面的 pos 里已经抛了
    .filter((e) => e.end >= e.start)
    .sort((a, b) => a.start - b.start);

  // 重叠 = 服务端清单本身有问题；硬改会把两次替换拼成一句谁也不认识的话，
  // 丢掉一条又会漏改。两种都不该悄悄发生，整体中止更诚实。
  let limit = -1;
  for (const e of list) {
    if (e.start < limit) {
      throw new Error("语言服务给出的编辑范围互相重叠，已中止（没有写入任何文件），请重试");
    }
    limit = e.end;
  }

  // 从后往前改：每个编辑的行列都是相对原文算的，正着改会让后面的偏移全部错位
  let out = text;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
