import { Icon } from "../ui/icon";
import { openLinkedDialog, type LinkedSection } from "../../lib/linkedDialog";
import type { CompileDiagnostic } from "../../lib/compile";

/** Cross-project diagnostics retain their repair destinations rather than bypassing the file path guard. */
export function ProblemDiagnostics({ diags }: { diags: CompileDiagnostic[] }) {
  return <>{diags.map((d, i) => {
    const target: LinkedSection | null = d.kind === "disabled" ? "overrides" : d.kind === "uncompiled" || d.kind === "stale-class" ? "chain" : null;
    return <div key={`${d.kind}:${d.project}:${i}`} className="wb-prow wb-diag" data-kind={d.kind}><Icon name="info" size={14} className="wb-prow-warn" /><span className="wb-prow-msg">{d.message}{d.file && <span className="wb-diag-path">{d.file}</span>}</span><span className="wb-prow-loc">{d.project}</span>{target && <button type="button" className="wb-diag-act" title="在「工程关联」里处理" onClick={() => openLinkedDialog(target)}>{target === "overrides" ? "覆盖规则" : "依赖链"}</button>}</div>;
  })}</>;
}
