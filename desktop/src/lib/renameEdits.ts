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
 * 重叠的编辑直接跳过（重命名里不该出现，出现了说明服务端给的清单本身有问题，
 * 硬改只会把两个替换拼成一句谁也不认识的话）。
 */
export function applyLspEdits(text: string, edits: LspTextEdit[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  const offsetOf = (p: LspPos): number => {
    if (p.line < 0) return 0;
    const base = starts[Math.min(p.line, starts.length - 1)];
    return Math.min(base + Math.max(0, p.character), text.length);
  };
  const list = edits
    .map((e) => ({ start: offsetOf(e.range.start), end: offsetOf(e.range.end), text: e.newText }))
    .filter((e) => e.end >= e.start)
    .sort((a, b) => a.start - b.start);

  // 重叠的只留**位置靠前**的那一条，其余丢掉。重命名里不该出现重叠，出现了说明服务端
  // 给的清单本身有问题；硬改只会把两次替换拼成一句谁也不认识的话，丢掉至少还是一句人话。
  const accepted: typeof list = [];
  let limit = -1;
  for (const e of list) {
    if (e.start < limit) continue;
    accepted.push(e);
    limit = e.end;
  }

  // 从后往前改：每个编辑的行列都是相对原文算的，正着改会让后面的偏移全部错位
  let out = text;
  for (let i = accepted.length - 1; i >= 0; i--) {
    const e = accepted[i];
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
