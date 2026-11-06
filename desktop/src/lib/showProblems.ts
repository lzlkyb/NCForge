import { revealWorkbenchPanel } from "./workbenchLayout";
import { setSession } from "./workspaceSession";
import type { ProblemPathScope } from "./diagnosticScope";

export function showProblems(path: string, scope: ProblemPathScope = "file"): void {
  revealWorkbenchPanel("problems");
  setSession({ problemsPath: path, problemsPathScope: scope, panelOpen: true, panelTab: "problems", serviceExpanded: false });
}
