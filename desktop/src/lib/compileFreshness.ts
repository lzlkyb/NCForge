import type { CompileResult } from "./compile";
import { diagnosticPathKey } from "./diagnosticScope";
import { moduleOf } from "./ncModule";
import { dirName } from "./workspace";

export function captureCompileSources(tabs: readonly { path: string; mtimeMs?: number }[] = []): Record<string, number> {
  return Object.fromEntries(tabs.filter(t => !t.path.includes("://") && Number.isFinite(t.mtimeMs)).map(t => [diagnosticPathKey(t.path), t.mtimeMs!]));
}
/** Capture before awaiting the compiler: a save during compilation must not make an older disk result look current. */
export function stampCompileResult(result: CompileResult, captured: Record<string, number>, root: string | null, files?: readonly string[], atMs = Date.now()): CompileResult {
  const targets = files ? new Set(files.map(diagnosticPathKey)) : null;
  const modules = result.modules?.length ? new Set(result.modules.filter(m => m.status !== "skipped" && m.status !== "blocked").map(m => m.module.toLowerCase())) : null;
  const sourceSnapshots = Object.fromEntries(Object.entries(captured).filter(([path]) => targets ? targets.has(path) : root && !path.startsWith(`${diagnosticPathKey(root)}/`) ? false : modules && root ? modules.has(moduleOf(root, dirName(path))?.toLowerCase() ?? "") : true).map(([path, mtimeMs]) => [path, { mtimeMs, atMs }]));
  return { ...result, completedAtMs: atMs, sourceSnapshots };
}
export function mergeCompileSnapshots(previous: CompileResult, next: CompileResult, touched: (path: string) => boolean): Partial<CompileResult> {
  if (!previous.sourceSnapshots && !next.sourceSnapshots) return {};
  return { sourceSnapshots: { ...Object.fromEntries(Object.entries(previous.sourceSnapshots ?? {}).filter(([path]) => !touched(path))), ...next.sourceSnapshots } };
}

export function compileSourceChanged(tab: { path: string; dirty?: boolean; eolChanged?: boolean; mtimeMs?: number }, result?: CompileResult | null): boolean {
  const snapshot = result?.sourceSnapshots?.[diagnosticPathKey(tab.path)];
  return !!(tab.dirty || tab.eolChanged || snapshot && snapshot.mtimeMs !== tab.mtimeMs);
}
