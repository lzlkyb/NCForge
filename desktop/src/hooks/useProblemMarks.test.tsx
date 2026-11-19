// @vitest-environment jsdom
import { act, memo } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useProblemMarks } from "./useProblemMarks";
import { getSession, setSession, type TabMeta } from "../lib/workspaceSession";
import { getCodeDiags, setCodeDiags } from "../lib/diagStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("a first edit in another file does not rerender an unchanged tree badge index", () => {
  const before = getSession(), diags = getCodeDiags(), renders = vi.fn();
  const file: TabMeta = { path: "C:/w/B.java", name: "B.java", dirty: false, encoding: "UTF-8", eol: "LF",
    hasBom: false, eolChanged: false, lines: 20, bytes: 640, mtimeMs: 2, readOnly: false, readOnlyReason: null };
  const BadgeIndex = memo(({ marks }: { marks: ReturnType<typeof useProblemMarks> }) => {
    renders(); return <span>{marks.paths.get("c:/w/a.java")?.errors ?? 0}</span>;
  });
  function Probe() { return <BadgeIndex marks={useProblemMarks()} />; }
  setSession({ root: "C:/w", tabs: [file], compileResult: null });
  setCodeDiags([{ path: "C:/w/A.java", line: 1, column: 1, severity: "warning", message: "unused" }]);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    act(() => root.render(<Probe />)); expect(renders).toHaveBeenCalledOnce();
    act(() => setSession({ tabs: [{ ...file, dirty: true }] }));
    expect(renders).toHaveBeenCalledOnce();
    act(() => setCodeDiags([{ path: "C:/w/A.java", line: 1, column: 1, severity: "error", message: "failed" }]));
    expect(renders).toHaveBeenCalledTimes(2); expect(host.textContent).toBe("1");
  } finally { act(() => root.unmount()); host.remove(); setSession(before); setCodeDiags(diags); }
});
