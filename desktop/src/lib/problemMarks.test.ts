import { expect, it } from "vitest";
import { buildProblemMarks } from "./problemMarks";
import { mergeProblems } from "./problemList";
import type { TabMeta } from "./workspaceSession";

it("deduplicates sources, keeps same-line columns distinct, and marks stale builds", () => {
  const file = "C:/w/mod/p/A.java";
  const source = { path: file, line: 5, message: "Unknown symbol", severity: "error" as const };
  const merged = mergeProblems(
    [{ file, line: 5, message: source.message, severity: "warning" }],
    [{ ...source, path: "c:\\W\\mod\\p\\A.java", column: 5 }, { ...source, column: 12 }],
  );
  expect(merged.map(p => p.column)).toEqual([5, 12]);
  expect(merged[0]).toMatchObject({ severity: "error", alsoInspected: true });
  const tabs: TabMeta[] = [{ path: file, name: "A.java", dirty: true, encoding: "UTF-8", eol: "LF",
    hasBom: false, eolChanged: false, lines: 20, mtimeMs: 2, readOnly: false, readOnlyReason: null }];
  const { paths } = buildProblemMarks(merged, "C:/w", null, tabs);
  expect(paths.get("c:/w/mod")).toEqual({ errors: 2, warnings: 0, live: 2, compiled: 1, stale: true });
});

it("aggregates ancestors while flat Java packages count only their own files", () => {
  const diag = { line: 1, column: 1, message: "x", severity: "warning" as const };
  const merged = mergeProblems(undefined, [
    { ...diag, path: "C:/w/pkg/A.java" },
    { ...diag, path: "C:/w/pkg/sub/B.java" },
    { ...diag, path: "C:/w/pkg/Hint.java", severity: "info" },
    { ...diag, path: "C:/workspace-other/pkg/A.java" },
  ]);
  const { paths, packages } = buildProblemMarks(merged, "C:/w/", null, []);
  expect(paths.get("c:/w/pkg")?.warnings).toBe(2);
  expect(packages.get("c:/w/pkg")?.warnings).toBe(1);
  expect(packages.get("c:/w/pkg/sub")?.warnings).toBe(1);
  expect(paths.get("c:/w/pkg/hint.java")).toBeUndefined();
  expect(paths.get("c:/workspace-other")).toBeUndefined();
  expect(buildProblemMarks(merged, null, null, []).paths.size).toBe(0);
});
