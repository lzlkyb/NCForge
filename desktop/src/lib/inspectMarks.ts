// jdt.ls 代码检查按路径聚合，供树/标签的独立徽标使用。
//
// 为什么不和编译问题合成一个数字：两者的覆盖范围根本不同——ecj 是整工程编译结果，
// jdt.ls 只看打开的文件。混成一个数会让人以为「树上的 5」都能在面板里逐条找到。
// 两个徽标各说各的来源，tooltip 分别写明「编译错误」和「代码检查（jdt.ls）」。
import { useMemo } from "react";
import { useCodeDiags, type CodeDiag } from "./diagStore";
import { markKey } from "./compileMarks";
import { useWorkspaceSelector } from "./workspaceSession";

export interface InspectMark {
  errors: number;
  warnings: number;
  /** 提示档（未使用导入、命名建议之类），不计入错误数，但徽标仍显示。 */
  info: number;
  total: number;
}

const EMPTY: ReadonlyMap<string, InspectMark> = new Map();
const cache = new WeakMap<
  readonly CodeDiag[],
  { root: string; marks: ReadonlyMap<string, InspectMark> }
>();

/** 文件行 + 每一级祖先目录（含工程根）累加；根外路径忽略。 */
export function buildInspectMarks(
  diags: readonly CodeDiag[],
  root: string,
): ReadonlyMap<string, InspectMark> {
  const r = markKey(root);
  if (!r) return EMPTY;
  const map = new Map<string, InspectMark>();
  const bump = (key: string, severity: CodeDiag["severity"]) => {
    const cur = map.get(key) ?? { errors: 0, warnings: 0, info: 0, total: 0 };
    map.set(key, {
      errors: cur.errors + (severity === "error" ? 1 : 0),
      warnings: cur.warnings + (severity === "warning" ? 1 : 0),
      info: cur.info + (severity === "info" ? 1 : 0),
      total: cur.total + 1,
    });
  };
  for (const d of diags) {
    const file = markKey(d.path);
    if (!file.startsWith(`${r}/`)) continue;
    bump(file, d.severity);
    let cut = file.lastIndexOf("/");
    while (cut >= r.length) {
      const dir = file.slice(0, cut);
      bump(dir, d.severity);
      if (dir.length === r.length) break;
      cut = dir.lastIndexOf("/");
    }
  }
  return map;
}

export function inspectMarkOf(
  marks: ReadonlyMap<string, InspectMark>,
  path: string,
): InspectMark | undefined {
  return marks.get(markKey(path));
}

export function useInspectMarks(): ReadonlyMap<string, InspectMark> {
  const diags = useCodeDiags();
  const root = useWorkspaceSelector((s) => s.root);
  return useMemo(() => {
    if (!root) return EMPTY;
    const hit = cache.get(diags);
    if (hit && hit.root === root) return hit.marks;
    const marks = buildInspectMarks(diags, root);
    cache.set(diags, { root, marks });
    return marks;
  }, [diags, root]);
}
