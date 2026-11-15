import { Icon } from "../ui/icon";
import { baseName } from "../../lib/workspace";
import { explainError } from "../../lib/rootCause";
import type { UnifiedProblem } from "../../lib/problemList";

export function ProblemRow({ problem: p, selected, onOpen, onPreview }: { problem: UnifiedProblem; selected: boolean; onOpen: () => void; onPreview: () => void }) {
  const source = p.alsoInspected ? "实时检查 + 最近编译" : p.source === "inspect" ? "实时检查" : "最近编译";
  const location = `${p.line}${p.column === undefined ? "" : `:${p.column}`}`;
  return <div className="dw-problem-row" data-selected={selected || undefined}>
    <button type="button" className="wb-prow" onClick={onOpen} title={`${p.path}:${location} · ${source}`}>
      <Icon name={p.severity === "info" ? "info" : "alertTriangle"} size={14} className={p.severity === "error" ? "wb-prow-err" : p.severity === "info" ? "wb-prow-info" : "wb-prow-warn"} />
      <span className="wb-prow-src" data-source={p.source}>{source}</span><span className="wb-prow-msg">{p.message}</span><span className="wb-prow-loc">{baseName(p.path)}:{location}</span>
    </button>
    <button type="button" className="wb-icon-btn dw-preview-button" aria-label={`预览 ${baseName(p.path)} 第 ${p.line} 行上下文`} aria-pressed={selected} title="预览上下文，保留当前编辑器" onClick={onPreview}><Icon name="eye" size={13} /></button>
  </div>;
}

/**
 * 错误行下面那句「这是什么」。
 *
 * 单独一行而不是塞进 title：根因的价值在于**不用悬停就能看见**——扫一遍列表就知道
 * 这十几条是同一类问题。认不出的条目什么都不渲染，不留空行。
 */
export function ProblemCause({ message }: { message: string }) {
  const cause = explainError(message);
  if (!cause) return null;
  return <p className="dw-problem-cause">
    <Icon name="info" size={11} />
    <span><strong>{cause.cause}</strong>{cause.action ? ` ${cause.action}` : ""}</span>
  </p>;
}
