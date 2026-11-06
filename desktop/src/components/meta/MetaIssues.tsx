import { useMemo, useState } from "react";
import type { BmfIssue } from "../../lib/bmf";
import { severityCounts } from "../../lib/bmfSummary";

const SEV_LABEL: Record<string, string> = { error: "错误", warn: "警告", info: "提示" };

/** 校验结果。每条都带「为什么」和「怎么改」——只报错不给出路的面板会被用户关掉。 */
export function MetaIssues({
  issues,
  loading,
  error,
  onLocate,
  canLocate,
}: {
  issues: BmfIssue[];
  loading: boolean;
  error: string | null;
  onLocate?: (issue: BmfIssue) => void;
  canLocate?: (issue: BmfIssue) => boolean;
}) {
  const [filter, setFilter] = useState<"all" | "error" | "warn" | "info">("all");
  const counts = useMemo(() => severityCounts(issues), [issues]);
  const shown = filter === "all" ? issues : issues.filter((i) => i.severity === filter);

  if (loading) return <p className="meta-note">正在校验…</p>;
  if (error) return <p className="meta-error">{error}</p>;

  return (
    <div className="meta-issues">
      <div className="meta-sev-bar">
        {(["all", "error", "warn", "info"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`meta-sev ${filter === k ? "is-active" : ""} sev-${k}`}
            onClick={() => setFilter(k)}
          >
            {k === "all" ? `全部 ${issues.length}` : `${SEV_LABEL[k]} ${counts[k]}`}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">
          零实体 / 未知节点等「合法但值得知道」的项记为提示，不当错误
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="meta-note">{issues.length === 0 ? "没有发现问题。" : "当前筛选下没有条目。"}</p>
      ) : (
        <div className="meta-issue-list">
          {shown.map((i) => (
            <article key={`${i.code}-${i.line ?? "x"}-${i.entity}-${i.attr}-${i.title}`} className={`meta-issue sev-${i.severity}`}>
              <header>
                <span className={`meta-sev-dot sev-${i.severity}`} />
                <strong>{i.title}</strong>
                <span className="meta-issue-code">{i.code}</span>
                {/* 后端 `line_of` 已经返回 1 基行号，这里不能再 +1。 */}
                {i.line != null && <span className="meta-issue-loc">第 {i.line} 行</span>}
                {(i.entity || i.attr) && (
                  <span className="meta-issue-loc">
                    {i.entity}
                    {i.attr ? ` / ${i.attr}` : ""}
                  </span>
                )}
                {onLocate && (canLocate?.(i) ?? !!i.entity) && <button type="button" className="meta-link" onClick={() => onLocate(i)}>定位对象</button>}
              </header>
              <p>{i.detail}</p>
              <p className="meta-issue-why">为什么：{i.why}</p>
              <p className="meta-issue-action">怎么改：{i.action}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
