/**
 * 行级差异（本地历史预览用）。
 *
 * 为什么自己写而不用现成库：只需要「旧版 vs 当前」的**行级** diff，引入
 * diff-match-patch 之类要为字符级算法付体积；而这个场景九成是「几行改动」，
 * 掐掉公共前后缀后中间段很小，一个 LCS 动态规划就够。
 *
 * 单独放文件（不并进 `localHistory.ts`）：那个文件顶层 import 了 tauri 的 invoke，
 * node 单测引它会把 `@tauri-apps/api` 拖进测试环境（本项目已踩过两次同类坑）。
 */

/** 一行差异的类型。same 保留两侧行号，del 只有旧行号，add 只有新行号。 */
export type DiffOp = "same" | "add" | "del";

export interface DiffRow {
  op: DiffOp;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffResult {
  /** 文件太大没算（行数超上限）。这时只展示大小，不给 diff。 */
  tooBig: boolean;
  rows: DiffRow[];
}

/** 单侧进入 LCS 的最大行数。4000 行的 BO 改几行也不会超。 */
const MAX_SIDE_LINES = 4000;
/** 掐掉公共前后缀后，中间段参与 LCS 的最大面积（行 × 行）。 */
const MAX_DP_CELLS = 4_000_000;

/**
 * 比较两个文本，返回行级差异（旧的在前、新的在后，按顺序平铺）。
 */
export function diffLines(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length > MAX_SIDE_LINES || newLines.length > MAX_SIDE_LINES) {
    return { tooBig: true, rows: [] };
  }

  // 先掐公共前后缀：绝大多数历史版本与当前只差几行，掐完中间段是个小方阵。
  // 不先掐的话，一个 3000 行的文件改 1 行也要算 900 万格。
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const oldMid = oldLines.slice(head, oldLines.length - tail);
  const newMid = newLines.slice(head, newLines.length - tail);
  if (oldMid.length * newMid.length > MAX_DP_CELLS) {
    return { tooBig: true, rows: [] };
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < head; i++) {
    rows.push({ op: "same", text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }
  appendLcs(rows, oldMid, newMid, head);
  const newTailStart = newLines.length - tail;
  const oldTailStart = oldLines.length - tail;
  for (let i = 0; i < tail; i++) {
    rows.push({
      op: "same",
      text: oldLines[oldTailStart + i],
      oldLine: oldTailStart + i + 1,
      newLine: newTailStart + i + 1,
    });
  }
  return { tooBig: false, rows };
}

/** LCS 回溯，把中间段的差异追加进 rows。行号偏移 = head（公共前缀占了 head 行）。 */
function appendLcs(rows: DiffRow[], oldMid: string[], newMid: string[], head: number) {
  const a = oldMid;
  const b = newMid;
  if (a.length === 0 && b.length === 0) return;
  if (a.length === 0) {
    // 旧版没有这些行 = 全是新增
    for (let j = 0; j < b.length; j++) {
      rows.push({ op: "add", text: b[j], newLine: head + j + 1 });
    }
    return;
  }
  if (b.length === 0) {
    for (let i = 0; i < a.length; i++) {
      rows.push({ op: "del", text: a[i], oldLine: head + i + 1 });
    }
    return;
  }

  const m = a.length;
  const n = b.length;
  const w = n + 1;
  // dp[i*(n+1)+j] = a[i..] 与 b[j..] 的 LCS 长度。一维 Uint32Array 比二维数组省一半以上
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ op: "same", text: a[i], oldLine: head + i + 1, newLine: head + j + 1 });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      rows.push({ op: "del", text: a[i], oldLine: head + i + 1 });
      i += 1;
    } else {
      rows.push({ op: "add", text: b[j], newLine: head + j + 1 });
      j += 1;
    }
  }
  while (i < m) {
    rows.push({ op: "del", text: a[i], oldLine: head + i + 1 });
    i += 1;
  }
  while (j < n) {
    rows.push({ op: "add", text: b[j], newLine: head + j + 1 });
    j += 1;
  }
}

/** 统计差异行数（面板标题用：「+3 −1」）。 */
export function countChanges(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.op === "add") added += 1;
    else if (r.op === "del") removed += 1;
  }
  return { added, removed };
}

/** 折叠后的一行：要么是真实差异行，要么是「省略了 N 行相同内容」的占位。 */
export type DiffItem =
  | { kind: "row"; row: DiffRow }
  | { kind: "gap"; count: number };

/**
 * 把 diff 里大段未改动的行折叠成占位，只留改动附近 `context` 行。
 *
 * 不折叠的话，一个 3000 行文件改 1 行也要渲染 3000 个 DOM 节点；而用户想看
 * 的只是「改哪儿了」。折叠后通常只剩几十行。
 */
export function collapseDiff(rows: DiffRow[], context = 2): DiffItem[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].op === "same") continue;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) {
      keep[k] = true;
    }
  }
  const items: DiffItem[] = [];
  let gap = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (gap > 0) {
        items.push({ kind: "gap", count: gap });
        gap = 0;
      }
      items.push({ kind: "row", row: rows[i] });
    } else {
      gap += 1;
    }
  }
  if (gap > 0) items.push({ kind: "gap", count: gap });
  return items;
}
