import { useMemo, useState } from "react";
import type { BmfIssue } from "../../lib/bmf";

const SEV_LABEL: Record<string, string> = { error: "错误", warn: "警告", info: "提示" };

/** 校验结果。每条都带「为什么」和「怎么改」——只报错不给出路的面板会被用户关掉。 */
export function MetaIssues({
  issues,
  loading,
  error,
}: {
  issues: BmfIssue[];
  loading: boolean;
  error: string | null;
}) {
  const [filter, setFilter] = useState<"all" | "error" | "warn" | "info">("all");
  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0 };
    for (const i of issues) {
      if (i.severity in c) c[i.severity as keyof typeof c]++;
    }
    return c;
  }, [issues]);
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
            <article key={`${i.code}-${i.entity}-${i.attr}-${i.title}`} className={`meta-issue sev-${i.severity}`}>
              <header>
                <span className={`meta-sev-dot sev-${i.severity}`} />
                <strong>{i.title}</strong>
                <span className="meta-issue-code">{i.code}</span>
                {i.line != null && <span className="meta-issue-loc">第 {i.line + 1} 行</span>}
                {(i.entity || i.attr) && (
                  <span className="meta-issue-loc">
                    {i.entity}
                    {i.attr ? ` / ${i.attr}` : ""}
                  </span>
                )}
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
