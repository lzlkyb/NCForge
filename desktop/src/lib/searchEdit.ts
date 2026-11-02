// 搜索结果「轻量多缓冲」编辑：把每个命中行当成一行文本改，保存时逐文件写回。
//
// 为什么不做 Monaco 多模型 / 拼接文档：那需要把一份文档里的偏移映射回多个文件，
// 增删行、跨文件撤销都会立刻变复杂。这里只允许改命中行本身（不增删行），
// 一次改完再按原编码 / 换行写回，行为可预测，失败也能逐行说清楚。
import { getText, replaceContent } from "./editorStore";
import { captureLocalHistory } from "./localHistory";
import { cleanError, joinPath, readFile, writeFile } from "./workspace";

/** 一行待写回的编辑。`original` 是打开预览时读到的整行原文，用来挡住「搜索后文件又变了」。 */
export interface LineDraft {
  /** 相对工作区根、`/` 分隔（与 `SearchHit.path` 一致）。 */
  path: string;
  line: number;
  original: string;
  value: string;
}

export interface SaveLineEditsResult {
  filesChanged: number;
  linesChanged: number;
  /** 实际写回的行（预览据此把已保存行标成新的原文，避免重复保存被当成冲突）。 */
  saved: { path: string; line: number; value: string }[];
  /** 没写回的文件 / 行与原因；成功的批次为空。 */
  skipped: string[];
}

/**
 * 逐文件写回命中行。
 *
 * 同一个文件只读一次、写一次；行号基于读取时的文本，所以同一批里重复的命中行
 * 只算一次。以下情况跳过而不是硬写：编码或换行无法无损往返、混合换行、
 * 编辑器里有未保存改动、行内容在预览后被别人改过、行号越界。
 */
export async function saveLineEdits(
  root: string,
  drafts: LineDraft[],
): Promise<SaveLineEditsResult> {
  const changed = drafts.filter((d) => d.value !== d.original);
  const byPath = new Map<string, LineDraft[]>();
  for (const d of changed) {
    const key = d.path.toLowerCase();
    const list = byPath.get(key);
    if (list) list.push(d);
    else byPath.set(key, [d]);
  }

  const out: SaveLineEditsResult = { filesChanged: 0, linesChanged: 0, saved: [], skipped: [] };
  for (const list of byPath.values()) {
    const rel = list[0].path;
    const abs = joinPath(root, rel.replace(/\//g, "\\"));
    try {
      const content = await readFile(abs);
      if (!content.lossless) {
        out.skipped.push(`${rel}：编码或换行无法无损写回，已跳过`);
        continue;
      }
      if (content.eol === "MIXED") {
        out.skipped.push(`${rel}：混合换行（CRLF 与 LF 混用），已跳过`);
        continue;
      }
      // 编辑器里改了一半还没存：这时写盘会被之后的 Ctrl+S 悄悄覆盖掉
      const modelText = getText(abs);
      if (modelText !== undefined && modelText !== content.text) {
        out.skipped.push(`${rel}：编辑器里有未保存改动，先保存或关闭再试`);
        continue;
      }

      const lines = content.text.split("\n");
      const seen = new Set<number>();
      const applying: LineDraft[] = [];
      for (const d of list) {
        if (seen.has(d.line)) continue;
        seen.add(d.line);
        if (d.value.includes("\n") || d.value.includes("\r")) {
          out.skipped.push(`${rel}:${d.line}：轻量编辑不支持换行，已跳过`);
          continue;
        }
        if (d.line < 1 || d.line > lines.length) {
          out.skipped.push(`${rel}:${d.line}：文件里已经没有这一行，已跳过`);
          continue;
        }
        if (lines[d.line - 1] !== d.original) {
          out.skipped.push(`${rel}:${d.line}：搜索后这一行已被改动，已跳过`);
          continue;
        }
        applying.push(d);
      }
      if (applying.length === 0) continue;

      for (const d of applying) lines[d.line - 1] = d.value;
      const text = lines.join("\n");
      await captureLocalHistory(abs).catch(() => {});
      const mtimeMs = await writeFile({
        path: abs,
        text,
        encoding: content.encoding,
        hasBom: content.hasBom,
        eol: content.eol,
        expectedMtimeMs: content.mtimeMs,
      });
      // 文件正好开着且干净：把 model 换成刚写的内容，否则编辑器里还是旧文本，
      // 用户下一次保存又会把这批修改撤回去。
      if (modelText !== undefined) {
        replaceContent(abs, { ...content, text, mtimeMs, size: text.length });
      }
      out.filesChanged += 1;
      out.linesChanged += applying.length;
      for (const d of applying) out.saved.push({ path: d.path, line: d.line, value: d.value });
    } catch (e) {
      out.skipped.push(`${rel}：${cleanError(e)}`);
    }
  }
  return out;
}
