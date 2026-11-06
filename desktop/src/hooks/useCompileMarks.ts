import { useMemo } from "react";
import type { CompileResult } from "../lib/compile";
import { buildCompileMarks, type ProblemMark } from "../lib/compileMarks";
import { useWorkspaceSelector } from "../lib/workspaceSession";

const EMPTY: ReadonlyMap<string, ProblemMark> = new Map();

/**
 * 同一轮编译结果只算一次标记表。
 *
 * 树是递归渲染的，每个展开的目录都会调这个 hook；没有缓存的话一次结果要按
 * 目录数重复遍历全部问题。`compileResult` 每次合并都是新对象，WeakMap 里的
 * 旧结果会自然回收。
 */
const cache = new WeakMap<
  CompileResult,
  { root: string; marks: ReadonlyMap<string, ProblemMark> }
>();

export function useCompileMarks(): ReadonlyMap<string, ProblemMark> {
  const result = useWorkspaceSelector((s) => s.compileResult);
  const root = useWorkspaceSelector((s) => s.root);
  return useMemo(() => {
    if (!result || !root) return EMPTY;
    const hit = cache.get(result);
    if (hit && hit.root === root) return hit.marks;
    const marks = buildCompileMarks(result.problems, root);
    cache.set(result, { root, marks });
    return marks;
  }, [result, root]);
}
