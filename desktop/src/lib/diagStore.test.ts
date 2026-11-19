import { afterEach, expect, it } from "vitest";
import { getCodeDiagsForPath, setCodeDiags, type CodeDiag } from "./diagStore";

afterEach(() => setCodeDiags([]));
it("indexes diagnostics by Windows path and keeps unaffected file snapshots stable", () => {
  const a: CodeDiag = { path: "C:\\w\\A.java", line: 1, column: 2, severity: "warning", message: "unused" };
  const b: CodeDiag = { ...a, path: "C:\\w\\B.java", message: "missing" };
  setCodeDiags([a, b]);
  const first = getCodeDiagsForPath("c:/W/a.java");
  expect(first).toEqual([a]);
  setCodeDiags([{ ...a }, { ...b, message: "changed" }]);
  expect(getCodeDiagsForPath(a.path)).toBe(first);
  expect(getCodeDiagsForPath(b.path)[0].message).toBe("changed");
  setCodeDiags([b]);
  expect(getCodeDiagsForPath(a.path)).toHaveLength(0);
  expect(getCodeDiagsForPath(a.path)).toBe(getCodeDiagsForPath("unknown.java"));
});
