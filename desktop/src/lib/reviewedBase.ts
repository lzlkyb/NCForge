/**
 * 「只看新改动」的左侧文本（按需求审查 P2）：把已审的改动块并进 SVN BASE。
 *
 * 对比左侧换成「BASE + 已审的块」之后，右侧不变，差异里就只剩没审的块——
 * 审完后又被改过的块指纹变了、不再算已审，自然重新出现。纯函数。
 */
import { normalizeEol, type ChangedBlock } from "./changedLines";

/**
 * `blocks` 必须是 `computeChanged(base, 当前)` 的结果（基线行号与 `base` 对得上）。
 * 返回 LF 换行的文本（Monaco 模型一律 LF，比较不受影响）。
 */
export function reviewedBase(base: string, blocks: readonly ChangedBlock[], isReviewed: (b: ChangedBlock) => boolean): string {
  const text = normalizeEol(base);
  // 新增文件：整篇一块，审了就和右侧一样
  if (text === "") return blocks.length === 1 && isReviewed(blocks[0]) ? blocks[0].currentLines.join("\n") : "";
  const lines = text.split("\n");
  const out: string[] = [];
  let next = 1;
  for (const b of [...blocks].sort((x, y) => x.oldStart - y.oldStart)) {
    while (next < b.oldStart) out.push(lines[next++ - 1]);
    out.push(...(isReviewed(b) ? b.currentLines : b.baseLines));
    next = Math.max(next, b.oldEnd + 1);
  }
  while (next <= lines.length) out.push(lines[next++ - 1]);
  return out.join("\n");
}
