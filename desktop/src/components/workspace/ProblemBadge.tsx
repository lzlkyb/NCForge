import { Icon } from "../ui/icon";
import type { ProblemMark } from "../../lib/problemMarks";
import { showProblems } from "../../lib/showProblems";
import type { ProblemPathScope } from "../../lib/diagnosticScope";

export function problemDescription(mark?: ProblemMark): string {
  if (!mark) return "";
  return [
    mark.errors && `${mark.errors} 个错误`,
    mark.warnings && `${mark.warnings} 个警告`,
    mark.live && `实时检查 ${mark.live} 条`,
    mark.compiled && `最近编译 ${mark.compiled} 条`,
    mark.stale && "部分编译结果需重新编译确认",
  ].filter(Boolean).join(" · ");
}

export function ProblemBadge({ mark, path, name, scope = "file", tabStop }: {
  mark?: ProblemMark;
  path: string;
  name: string;
  scope?: ProblemPathScope;
  tabStop?: boolean;
}) {
  if (!mark) return null;
  const severity = mark.errors ? "error" : "warning";
  const total = mark.errors + mark.warnings;
  const description = problemDescription(mark);
  return <button type="button" className="wb-problem-badge" data-sev={severity} data-stale={mark.stale || undefined}
    tabIndex={tabStop ? 0 : -1} title={description} aria-label={`查看 ${name} 的问题 · ${description}`}
    onClick={event => { event.stopPropagation(); showProblems(path, scope); }}
    onDoubleClick={event => event.stopPropagation()}>
    {severity === "error" ? (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <circle cx="8" cy="8" r="6" /><path d="m6 6 4 4m0-4-4 4" />
      </svg>
    ) : <Icon name="alertTriangle" size={12} />}
    {scope === "file" && (total > 99 ? "99+" : total)}
  </button>;
}
