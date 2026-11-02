/**
 * 「转到任意位置」的纯逻辑：`:行号` 解析、最近使用排序、文件排序的最近加成。
 *
 * 图标 / 文件 / 符号 / 内容 / 命令共用一个输入框时，最近用过的目标应该排在前面——
 * 这是唯一一处把「最近」参与打分的计算，放在纯函数里便于验证方向没写反。
 */
import { rankFiles, type FileEntry, type RankedFile } from "./fuzzy";

/** `:12` / `:12:5`（行列都 1 基）。解析不了返回 null。 */
export function parseLineQuery(query: string): { line: number; column?: number } | null {
  const m = /^:(\d+)(?::(\d+))?$/.exec(query.trim());
  if (!m) return null;
  const line = Number(m[1]);
  if (!Number.isSafeInteger(line) || line < 1) return null;
  if (m[2] === undefined) return { line };
  const column = Number(m[2]);
  if (!Number.isSafeInteger(column) || column < 1) return null;
  return { line, column };
}

/** 最近用过的排在前面，其余保持原顺序（稳定排序）。路径比较大小写不敏感。 */
export function recentFirst<T>(items: T[], pathOf: (item: T) => string, recent: string[]): T[] {
  if (recent.length === 0) return items;
  const rank = new Map(recent.map((p, i) => [p.toLowerCase(), i]));
  return items
    .map((item, i) => ({ item, i, at: rank.get(pathOf(item).toLowerCase()) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.item);
}

/** 最近加成的上限：足以把同分附近的条目顶上去，但压不过文件名完全相等（+200）。 */
const RECENT_BONUS = 10;

/**
 * `rankFiles` 的最近加成版。
 *
 * 先多取一倍再重排：只取 limit 条就重排的话，排在第 51 位的常用文件永远进不了前 50。
 * 加成随最近顺位递减，但不会因为「刚打开过」就把一个名字完全不匹配的文件塞到第一。
 */
export function rankFilesRecent(
  files: FileEntry[],
  query: string,
  limit: number,
  recent: string[],
): RankedFile[] {
  const ranked = rankFiles(files, query, limit * 2);
  if (recent.length === 0) return ranked.slice(0, limit);
  const rank = new Map(recent.map((p, i) => [p.toLowerCase(), i]));
  return ranked
    .map((r, i) => {
      const at = rank.get(r.entry.path.toLowerCase());
      return { r, i, score: r.score + (at === undefined ? 0 : Math.max(0, RECENT_BONUS - at / 2)) };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.r);
}
