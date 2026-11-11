/**
 * 单块还原：把一块改动的新侧行替换回基线内容。
 *
 * 这里是**纯函数**，只算出要施加的编辑范围与文本；真正写进 buffer 由
 * `changedLinesGutter` 用 `executeEdits` 完成（那样才有一次完整的 undo 步）。
 * 拆开的原因：A2 是三批里唯一会改用户代码的操作，必须能脱离 Monaco 单测。
 *
 * 三个形态：
 * - 替换/新增块有基线内容：把 [startLine, endLine] 换成基线文本。
 * - 纯删除块没有新侧行：在插入点行首插回基线行。
 * - 纯新增块没有基线内容：连同行尾换行一起删掉整块，避免留下一个空行
 *   （只把 range 换成 "" 会留空行，用户还得再手动删一次）。
 *
 * 写回的文本一律 LF：Monaco 模型是 LF 归一的，保存时后端按文件原 eol 还原，
 * 直接用基线原文（可能 CRLF）会「看着一样、存进去变了」。
 */
import { blockFingerprint, type ChangedBlock, type ChangedSnapshot } from "./changedLines";

export interface RevertEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

/**
 * @param allLines 当前模型的所有行（`model.getLinesContent()`），用来算列号与末行边界。
 *                 快照之后用户可能又编辑过，所以列号必须按「现在的模型」算。
 */
export function revertEdit(block: ChangedBlock, allLines: readonly string[]): RevertEdit {
  const lineCount = Math.max(1, allLines.length);
  const colEnd = (line: number) => (allLines[line - 1]?.length ?? 0) + 1;
  // 纯删除块的 startLine 是「插入点」，删到文件末尾时会等于 行数+1（越界）。
  // 先记下原值：夹到第一行会把基线内容插到文件开头（"b\na"），必须接到末行行尾。
  const rawStart = block.startLine;
  const startLine = Math.min(Math.max(1, rawStart), lineCount);
  const endLine = Math.min(Math.max(startLine, block.endLine), lineCount);
  const baseText = block.baseLines.join("\n");

  // 纯删除：基线有内容、新侧没有 → 在插入点行首插回，并补一个换行把原行挤下去
  if (block.currentLines.length === 0) {
    if (rawStart > lineCount) {
      const end = colEnd(lineCount);
      return { startLine: lineCount, startColumn: end, endLine: lineCount, endColumn: end, text: `\n${baseText}` };
    }
    return {
      startLine,
      startColumn: 1,
      endLine: startLine,
      endColumn: 1,
      text: baseText + "\n",
    };
  }

  // 有基线内容：整块替换成基线文本
  if (baseText.length > 0 || block.baseLines.length > 0) {
    return {
      startLine,
      startColumn: 1,
      endLine,
      endColumn: colEnd(endLine),
      text: baseText,
    };
  }

  // 纯新增：删掉整块行。块后面还有行时把行尾换行一起吃掉；
  // 块在文件末尾时从上一行末尾开始删；整篇都是新增就只留一个空行。
  if (endLine < lineCount) {
    return { startLine, startColumn: 1, endLine: endLine + 1, endColumn: 1, text: "" };
  }
  if (startLine > 1) {
    return {
      startLine: startLine - 1,
      startColumn: colEnd(startLine - 1),
      endLine,
      endColumn: colEnd(endLine),
      text: "",
    };
  }
  return { startLine: 1, startColumn: 1, endLine, endColumn: colEnd(endLine), text: "" };
}

/**
 * 还原前重定位（P0-6）：浮层非模态、装饰重算还有 800ms 防抖，点「还原此块」时
 * 旧 block 的 startLine/endLine 可能已经过期，在块前插一行就会改错无辜的一行。
 *
 * 做法：调用方按当前模型内容重算一份快照，这里按**块内容指纹**找回对应块，
 * 用新块的行号写回。匹配不上返回 null，调用方提示「文件已变化，请重新点击色条」，
 * 绝不盲写。内容指纹不含新侧行号，所以在块后插行仍能定位。
 */
export function locateBlock(block: ChangedBlock, fresh: ChangedSnapshot): ChangedBlock | null {
  const key = blockFingerprint(block);
  return fresh.blocks.find((b) => blockFingerprint(b) === key) ?? null;
}
