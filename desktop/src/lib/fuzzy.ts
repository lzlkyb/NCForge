/**
 * 「转到文件 / 类型 / 命令」的模糊匹配。
 *
 * 子序列匹配（`vbo` → `VoucherBO`），得分鼓励：连续命中、落在词首（开头 / 分隔符后 / 驼峰大写）。
 * 用动态规划取最优落点而不是贪心——贪心会把 `bo` 匹配到 `Voucher` 里的 `o`，而不是用户想要的 `BO`。
 * 文本都很短（文件名 / 路径），先做一次 O(n) 的存在性预检，绝大多数不相关的条目在这一步就淘汰了。
 */

/** 命中区间，半开 `[start, end)`，下标按 UTF-16 代码单元。 */
export type Range = [number, number];

export interface FuzzyHit {
  score: number;
  ranges: Range[];
}

const SEPARATOR = /[\\/._\- ]/;

/** 第 j 个字符是不是「词首」：给额外奖励。 */
function boundaryBonus(text: string, j: number): number {
  if (j === 0) return 8;
  const prev = text[j - 1];
  if (SEPARATOR.test(prev)) return 8;
  const cur = text[j];
  // 驼峰边界：前一个是小写、当前是大写
  if (prev !== prev.toUpperCase() && cur !== cur.toLowerCase()) return 6;
  return 0;
}

const CONSECUTIVE = 5;
const GAP_PENALTY = 0.1;
const NEG = -1e9;

export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const n = q.length;
  const m = t.length;
  if (n === 0) return { score: 0, ranges: [] };
  if (n > m) return null;

  // 存在性预检
  let k = 0;
  for (let j = 0; j < m && k < n; j++) if (t[j] === q[k]) k++;
  if (k < n) return null;

  // best[i][j]：query[0..i] 匹配完、且 query[i] 落在 text[j] 时的最高分；from 记前一个字符的落点
  const best: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < n; i++) {
    best.push(new Array<number>(m).fill(NEG));
    from.push(new Array<number>(m).fill(-1));
  }
  for (let j = 0; j < m; j++) {
    if (t[j] === q[0]) best[0][j] = 1 + boundaryBonus(text, j) - j * GAP_PENALTY;
  }
  for (let i = 1; i < n; i++) {
    // run = max(best[i-1][p] + GAP_PENALTY * p)，p ≤ j-2；从「非相邻」的 p 转移要扣跨过的字符数
    let run = NEG;
    let runAt = -1;
    for (let j = i; j < m; j++) {
      const p2 = j - 2;
      if (p2 >= 0 && best[i - 1][p2] > NEG) {
        const v = best[i - 1][p2] + GAP_PENALTY * p2;
        if (v > run) {
          run = v;
          runAt = p2;
        }
      }
      if (t[j] !== q[i]) continue;
      const bonus = 1 + boundaryBonus(text, j);
      let top = NEG;
      let topFrom = -1;
      const adj = best[i - 1][j - 1];
      if (adj > NEG) {
        top = adj + CONSECUTIVE;
        topFrom = j - 1;
      }
      if (runAt >= 0 && run - GAP_PENALTY * (j - 1) > top) {
        top = run - GAP_PENALTY * (j - 1);
        topFrom = runAt;
      }
      if (topFrom >= 0) {
        best[i][j] = top + bonus;
        from[i][j] = topFrom;
      }
    }
  }

  let end = -1;
  let score = NEG;
  for (let j = 0; j < m; j++) {
    if (best[n - 1][j] > score) {
      score = best[n - 1][j];
      end = j;
    }
  }
  if (end < 0) return null;

  const idx: number[] = [];
  for (let i = n - 1, j = end; i >= 0; i--) {
    idx.push(j);
    j = from[i][j];
  }
  idx.reverse();
  const ranges: Range[] = [];
  for (const j of idx) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === j) last[1] = j + 1;
    else ranges.push([j, j + 1]);
  }
  return { score, ranges };
}

/** 一个可搜索的文件条目。 */
export interface FileEntry {
  /** 绝对路径（打开用）。 */
  path: string;
  /** 相对工作区根，`/` 分隔。 */
  rel: string;
  name: string;
  /** 所在目录（相对，`/` 分隔）。 */
  dir: string;
}

export interface RankedFile {
  entry: FileEntry;
  score: number;
  /** 命中落在文件名还是整条相对路径上（决定高亮画在哪）。 */
  on: "name" | "rel";
  ranges: Range[];
}

/**
 * 文件名优先的排序。文件名（不含扩展名）完全相等 / 前缀 / 子串依次加大奖励，其次才是文件名上的模糊匹配，
 * 最后才退到整条路径。查询里带 `/` 或 `\` 时用户在按路径找，直接只匹配整条路径。
 */
export function rankFiles(files: FileEntry[], query: string, limit: number): RankedFile[] {
  const q = query.trim().replace(/\\/g, "/");
  if (!q) return [];
  const byPath = q.includes("/");
  const lower = q.toLowerCase();
  const out: RankedFile[] = [];
  for (const entry of files) {
    if (!byPath) {
      const hit = fuzzyMatch(q, entry.name);
      if (hit) {
        const stem = entry.name.replace(/\.[^.]*$/, "").toLowerCase();
        let bonus = 0;
        if (stem === lower) bonus = 200;
        else if (stem.startsWith(lower)) bonus = 100;
        else if (stem.includes(lower)) bonus = 60;
        out.push({ entry, score: hit.score + bonus, on: "name", ranges: hit.ranges });
        continue;
      }
    }
    const hit = fuzzyMatch(q, entry.rel);
    if (hit) out.push({ entry, score: hit.score - 20, on: "rel", ranges: hit.ranges });
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.name.length - b.entry.name.length ||
      a.entry.rel.localeCompare(b.entry.rel),
  );
  return out.slice(0, limit);
}
