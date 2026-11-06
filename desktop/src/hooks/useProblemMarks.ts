import { useCallback, useMemo } from "react";
import { diagnosticPathKey } from "../lib/diagnosticScope";
import { useCodeDiags } from "../lib/diagStore";
import { mergeProblems } from "../lib/problemList";
import { buildProblemMarks } from "../lib/problemMarks";
import { useWorkspaceSelector } from "../lib/workspaceSession";

export function useProblemMarks() {
  const root = useWorkspaceSelector(s => s.root);
  const result = useWorkspaceSelector(s => s.compileResult);
  const tabs = useWorkspaceSelector(s => s.tabs);
  const diags = useCodeDiags();
  return useMemo(() => buildProblemMarks(mergeProblems(result?.problems, diags), root ?? null, result, tabs),
    [root, result, diags, tabs]);
}

export function useProblemTreeFilter(filter: string, onlyProblems: boolean, marks: ReturnType<typeof useProblemMarks>) {
  const text = filter.toLowerCase();
  return useCallback((name: string, path: string, isDir: boolean, kind?: string) => {
    const matchesName = !text || name.toLowerCase().includes(text);
    if (!onlyProblems) return kind === "project" || matchesName;
    const index = kind === "package" ? marks.packages : marks.paths;
    return index.has(diagnosticPathKey(path)) && (isDir || matchesName);
  }, [text, onlyProblems, marks]);
}
