// 「问题」的统一口径：ecj 编译问题 + jdt.ls 代码检查，合成一张表。
//
// 为什么必须合成：编译问题和代码检查经常说的是同一处（编译没跑过但波浪线已经在了），
// 分开数会让「问题」徽章显示 12、列表里却有 15 行；合成并按 路径+行号+原文 去重后，
// 徽章、列表、上/下一处三处用的是同一份数。
import type { Problem } from "./compile";
import type { CodeDiag } from "./diagStore";
import { diagnosticPathKey } from "./diagnosticScope";

export type ProblemSource = "compile" | "inspect";

export interface UnifiedProblem {
  path: string;
  line: number;
  column?: number;
  /**
   * 三档。`info` 目前只来自 jdt.ls 的代码检查（未使用的导入、命名建议之类）：
   * 它是提示不是问题，列表里照常显示（弱化配色），但徽章不数、「跳到下一处」跳过。
   */
  severity: "error" | "warning" | "info";
  message: string;
  source: ProblemSource;
  alsoInspected?: true;
}

const keyOf = (p: { path: string; line: number; message: string }) =>
  `${diagnosticPathKey(p.path)}|${p.line}|${p.message.trim()}`;

/**
 * 合并两份问题列表并去重，按「路径 → 行号」排序。
 *
 * 只对**完全同一条**去重（同文件、同行、同一句原文）。按「同一行」去重是错的：
 * 一行里两个不同错误会只剩一条，人修完一个以为什么都好了。
 */
export function mergeProblems(compile: Problem[] | undefined, inspect: CodeDiag[]): UnifiedProblem[] {
  const seen = new Map<string, UnifiedProblem[]>();
  const push = (p: UnifiedProblem) => {
    const k = keyOf(p);
    const matches = seen.get(k) ?? [];
    const same = matches.find(item => item.column === p.column)
      ?? matches.find(item => item.source !== p.source && item.column === undefined);
    if (!same) {
      matches.push(p);
      seen.set(k, matches);
    } else if (same.source !== p.source) {
      same.alsoInspected = true;
      same.column ??= p.column;
      if (p.severity === "error" || same.severity === "info") same.severity = p.severity;
    }
  };
  for (const p of compile ?? []) {
    push({ path: p.file, line: p.line, severity: p.severity, message: p.message, source: "compile" });
  }
  for (const d of inspect) {
    // 原样透传三档：以前这里把 info 抹成 warning，jdt.ls 的建议会和真警告一个待遇
    push({ path: d.path, line: d.line, column: d.column, severity: d.severity, message: d.message, source: "inspect" });
  }
  // 路径大小写不敏感：Windows 上同一个文件可能从小写盘符进、大写盘符出
  return [...seen.values()].flat().sort((a, b) => {
    const pa = diagnosticPathKey(a.path);
    const pb = diagnosticPathKey(b.path);
    return pa < pb ? -1 : pa > pb ? 1 : a.line - b.line || (a.column ?? 1) - (b.column ?? 1);
  });
}

export function countErrors(list: UnifiedProblem[]): number {
  return list.filter((p) => p.severity === "error").length;
}

export type ProblemFilter = "all" | "error" | "warning" | "info";

/** 按严重度筛。`all` 原样返回（列表已经是排好的）。 */
export function filterProblems(list: UnifiedProblem[], filter: ProblemFilter): UnifiedProblem[] {
  return filter === "all" ? list : list.filter((p) => p.severity === filter);
}

/** 按文件分组，组内保持「行号升序」（mergeProblems 已排好，这里只做切分）。 */
export function groupProblems(list: UnifiedProblem[]): { path: string; items: UnifiedProblem[] }[] {
  const groups: { path: string; items: UnifiedProblem[] }[] = [];
  for (const p of list) {
    const last = groups[groups.length - 1];
    if (last && diagnosticPathKey(last.path) === diagnosticPathKey(p.path)) last.items.push(p);
    else groups.push({ path: p.path, items: [p] });
  }
  return groups;
}

/** 复制用文本：一行一条，`路径:行  错误|警告|提示  原文`。 */
export function formatProblems(list: UnifiedProblem[]): string {
  return list
    .map((p) => `${p.path}:${p.line}  ${p.severity === "error" ? "错误" : p.severity === "warning" ? "警告" : "提示"}  ${p.message}`)
    .join("\n");
}

/**
 * 从当前位置找上一条 / 下一条问题，到头就从头再来。
 *
 * 「当前位置」用的是光标：人在 A 文件第 40 行，按「下一处」该去的是**这一条之后**的
 * 第一条（同文件更靠后的行，或者下一个文件的第一条），而不是每次都从整个列表第一条开始。
 * 有列号时可以在同一行的不同诊断之间跳转；跳过当前位置。
 *
 * info 档不参与跳转：未使用的导入、命名建议之类的提示，不该打断「逐个修错误」的节奏。
 * 列表里只剩 info 时返回 null（调用方会提示「没有可跳转的问题」）。
 */
export function nextProblem(
  list: UnifiedProblem[],
  from: { path: string; line: number; column?: number } | null,
  dir: 1 | -1,
): UnifiedProblem | null {
  const nav = list.filter((p) => p.severity !== "info");
  if (nav.length === 0) return null;
  if (!from) return dir > 0 ? nav[0] : nav[nav.length - 1];
  const p = diagnosticPathKey(from.path);
  const compare = (x: UnifiedProblem) => {
    const xp = diagnosticPathKey(x.path);
    return xp < p ? -1 : xp > p ? 1 : x.line - from.line
      || (from.column === undefined ? 0 : (x.column ?? 1) - from.column);
  };
  if (dir > 0) {
    return nav.find(x => compare(x) > 0) ?? nav[0];
  }
  // 倒着找「严格位于当前位置之前」的最后一条。
  // 不能用「第一条 after 的下标减一」：当前位置本身就在列表里（光标停在那条问题上），
  // 减一会减回它自己，按一下就看起来没反应。
  let last = -1;
  for (let i = 0; i < nav.length; i++) {
    if (compare(nav[i]) < 0) last = i;
  }
  return last >= 0 ? nav[last] : nav[nav.length - 1];
}
