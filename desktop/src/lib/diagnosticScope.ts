import type { UnifiedProblem } from "./problemList";
import { moduleOf } from "./ncModule";
import { dirName } from "./workspace";

export type ProblemPathScope = "file" | "branch" | "package";

export function problemsAtPath(problems: UnifiedProblem[], path: string, scope: ProblemPathScope): UnifiedProblem[] {
  const key = diagnosticPathKey(path);
  return problems.filter(problem => {
    const file = diagnosticPathKey(problem.path);
    if (scope === "file") return file === key;
    if (scope === "package") return file.slice(0, file.lastIndexOf("/")) === key;
    return file.startsWith(key + "/");
  });
}

export type DiagnosticScope = "project" | "module" | "file";
export const diagnosticPathKey = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export function scopeProblems(problems: UnifiedProblem[], scope: DiagnosticScope, root: string | null, activePath: string | null): UnifiedProblem[] {
  if (scope === "project") return problems;
  if (!activePath) return [];
  if (scope === "file") return problems.filter(p => diagnosticPathKey(p.path) === diagnosticPathKey(activePath));
  const module = root ? moduleOf(root, dirName(activePath)) : null;
  return module && root ? problems.filter(p => moduleOf(root, dirName(p.path))?.toLowerCase() === module.toLowerCase()) : [];
}
/** Context is bounded by lines and columns even when a diagnostic points at a very long generated line. */
export function sourceContext(text: string, line: number, radius = 3): { line: number; text: string; current: boolean }[] {
  const lines = text.split(/\r?\n/), current = Math.max(1, Math.min(Math.trunc(line) || 1, lines.length));
  return lines.slice(Math.max(0, current - radius - 1), current + radius).map((text, index) => ({ line: Math.max(1, current - radius) + index, text: text.length > 1000 ? `${text.slice(0, 1000)}…` : text, current: Math.max(1, current - radius) + index === current }));
}
