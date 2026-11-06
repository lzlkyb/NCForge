import { Icon } from "../ui/icon";
import { baseName } from "../../lib/workspace";
import type { UnifiedProblem } from "../../lib/problemList";

export function ProblemRow({ problem: p, selected, onOpen, onPreview }: { problem: UnifiedProblem; selected: boolean; onOpen: () => void; onPreview: () => void }) {
  return <div className="dw-problem-row" data-selected={selected || undefined}>
    <button type="button" className="wb-prow" onClick={onOpen} title={`${p.path}:${p.line} · ${p.source === "inspect" ? "jdt.ls 代码检查" : "ecj 编译问题"}`}>
      <Icon name={p.severity === "info" ? "info" : "alertTriangle"} size={14} className={p.severity === "error" ? "wb-prow-err" : p.severity === "info" ? "wb-prow-info" : "wb-prow-warn"} />
      <span className="wb-prow-src" data-source={p.source}>{p.source === "inspect" ? "jdt.ls" : "ecj"}</span><span className="wb-prow-msg">{p.message}</span><span className="wb-prow-loc">{baseName(p.path)}:{p.line}</span>
    </button>
    <button type="button" className="wb-icon-btn dw-preview-button" aria-label={`预览 ${baseName(p.path)} 第 ${p.line} 行上下文`} aria-pressed={selected} title="预览上下文，保留当前编辑器" onClick={onPreview}><Icon name="eye" size={13} /></button>
  </div>;
}
