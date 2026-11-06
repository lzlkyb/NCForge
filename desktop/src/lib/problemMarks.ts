import type { CompileResult } from "./compile";
import { compileSourceChanged } from "./compileFreshness";
import { diagnosticPathKey } from "./diagnosticScope";
import type { UnifiedProblem } from "./problemList";
import type { TabMeta } from "./workspaceSession";

export interface ProblemMark {
  errors: number;
  warnings: number;
  live: number;
  compiled: number;
  stale: boolean;
}

export function buildProblemMarks(problems: UnifiedProblem[], root: string | null, result: CompileResult | null, tabs: TabMeta[]) {
  const paths = new Map<string, ProblemMark>();
  const packages = new Map<string, ProblemMark>();
  const workspace = diagnosticPathKey(root ?? "");
  const changed = new Set(tabs.filter(tab => compileSourceChanged(tab, result)).map(tab => diagnosticPathKey(tab.path)));
  for (const p of problems) {
    if (p.severity === "info") continue;
    const file = diagnosticPathKey(p.path);
    if (!workspace || !file.startsWith(workspace + "/")) continue;
    const compiled = p.source === "compile";
    const bump = (index: Map<string, ProblemMark>, key: string) => {
      const mark = index.get(key) ?? { errors: 0, warnings: 0, live: 0, compiled: 0, stale: false };
      if (p.severity === "error") mark.errors++;
      else mark.warnings++;
      if (compiled) mark.compiled++;
      if (!compiled || p.alsoInspected) mark.live++;
      if (compiled && changed.has(file)) mark.stale = true;
      index.set(key, mark);
    };
    bump(paths, file);
    let cut = file.lastIndexOf("/");
    // A flat Java package contains its own files. Subpackages have their own sibling rows.
    bump(packages, file.slice(0, cut));
    while (cut >= workspace.length) {
      bump(paths, file.slice(0, cut));
      cut = file.lastIndexOf("/", cut - 1);
    }
  }
  return { paths, packages };
}
