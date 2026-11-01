import type { MatchRange, SearchHit } from "./search";

/**
 * 「全部替换」的纯计算：确认框里要给用户看的**预计改动面**与**预览**。
 *
 * 单独放一个文件（不并进 `search.ts`）：`search.ts` 顶层 import 了 tauri 的
 * invoke，node 单测引它会把 `@tauri-apps/api` 拖进 jsdom 之外的环境。
 * 本项目已经踩过两次同类坑（renameSymbol → renameEdits、dbActions → dbResultActions）。
 */

/**
 * 把一行文本按命中的 UTF-16 区间替换掉，返回替换后的样子。
 *
 * 区间是后端给的 **UTF-16 偏移**，正好是 JS 字符串下标。区间可能超出（后端
 * 截断过行文本），这里夹一次是防线——夹不住的空区间直接跳过。
 * 正则模式**不要用这个函数**：后端的 `$1` 展开语义与 JS 不同，预览会骗人。
 */
export function previewReplacedLine(text: string, ranges: MatchRange[], replacement: string): string {
  if (ranges.length === 0) return text;
  let out = "";
  let at = 0;
  for (const r of ranges) {
    const start = Math.max(at, Math.min(r.start, text.length));
    const end = Math.max(start, Math.min(r.end, text.length));
    out += text.slice(at, start) + replacement;
    at = end;
  }
  return out + text.slice(at);
}

export interface ReplacePlanFile {
  path: string;
  /** 该文件里的命中处数。 */
  count: number;
}

export interface ReplacePlan {
  /** 涉及的文件数。 */
  files: number;
  /** 命中总处数。 */
  hits: number;
  /** 按搜索顺序取的前若干个文件（确认框里列出来，剩下的合并成一行）。 */
  top: ReplacePlanFile[];
  /** `top` 之外还有几个文件。 */
  rest: number;
}

/**
 * 汇总一份搜索结果会被改动多少。
 *
 * ⚠️ 这是**预计值**：搜索有 `maxResults` 上限、替换有自己的时间预算，
 * 两者覆盖范围相同但不保证数量一致（搜索被截断时实际会改得更多）。
 * 调用方必须把这一点写进界面，不能让用户以为「就是 N 处」。
 */
export function replacePlan(hits: SearchHit[], maxTop = 8): ReplacePlan {
  const counts = new Map<string, number>();
  let total = 0;
  for (const h of hits) {
    // 按**处**计，不按行计：一行里出现 4 次就是 4 处。以前这里每行 +1，确认框
    // 说「3 处」而替换完报「12 处」——这是直接改磁盘、不进撤销历史的一次性动作，
    // 确认框的数字是用户唯一的下手依据，不能偏小。
    const n = h.ranges.length || 1;
    total += n;
    counts.set(h.path, (counts.get(h.path) ?? 0) + n);
  }
  const top: ReplacePlanFile[] = [];
  let rest = 0;
  let i = 0;
  for (const [path, count] of counts) {
    if (i < maxTop) top.push({ path, count });
    else rest += 1;
    i += 1;
  }
  return { files: counts.size, hits: total, top, rest };
}
