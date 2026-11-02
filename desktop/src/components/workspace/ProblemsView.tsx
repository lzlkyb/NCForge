import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { baseName } from "../../lib/workspace";
import { copyText } from "../../lib/utils";
import type { CompileDiagnostic, Problem } from "../../lib/compile";
import {
  filterProblems,
  formatProblems,
  groupProblems,
  type ProblemFilter,
  type UnifiedProblem,
} from "../../lib/problemList";

interface Props {
  /** 编译问题 + jdt.ls 代码检查合并去重后的列表（已按 路径→行号 排好）。 */
  problems: UnifiedProblem[];
  /** D4 诊断：ecj 原文之外的推断，不算错误数，不参与筛选。 */
  diags: CompileDiagnostic[];
  running: boolean;
  /** 是否编译过（决定空状态文案：没编译 vs 没问题）。 */
  compiled: boolean;
  onOpenProblem: (p: Problem) => void;
  onOpenAt: (path: string, line: number) => void;
}

const FILTERS: { key: ProblemFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "error", label: "错误" },
  { key: "warning", label: "警告" },
  { key: "info", label: "提示" },
];

const severityClass = (s: UnifiedProblem["severity"]) =>
  s === "error" ? "wb-prow-err" : s === "info" ? "wb-prow-info" : "wb-prow-warn";

/**
 * 「问题」页的主体：筛选、按文件分组、复制全部，以及编译诊断与代码检查行。
 *
 * 行语义保持拆出去之前的样子：ecj 编译问题点开跳到源码（onOpenProblem），
 * jdt.ls 代码检查虽然也跳（onOpenAt），但来源不同——只在打开的文件上有，
 * 所以行上带 title 写明来源，避免误以为「编译器也报了这条」。
 */
export function ProblemsView({ problems, diags, running, compiled, onOpenProblem, onOpenAt }: Props) {
  const [filter, setFilter] = useState<ProblemFilter>("all");
  const [grouped, setGrouped] = useState(false);
  const shown = filterProblems(problems, filter);
  const groups = groupProblems(shown);

  const open = (p: UnifiedProblem) => {
    if (p.source === "inspect") onOpenAt(p.path, p.line);
    // 统一列表里的 info 只来自 jdt.ls；编译问题没有 info 档
    else onOpenProblem({ file: p.path, line: p.line, severity: p.severity === "info" ? "warning" : p.severity, message: p.message });
  };

  const row = (p: UnifiedProblem, key: string) => (
    <button
      type="button"
      key={key}
      className="wb-prow"
      onClick={() => open(p)}
      title={`${p.path}:${p.line}${p.source === "inspect" ? "（jdt.ls 代码检查）" : ""}`}
    >
      <Icon
        name={p.severity === "info" ? "info" : "alertTriangle"}
        size={14}
        className={severityClass(p.severity)}
      />
      <span className="wb-prow-msg">{p.message}</span>
      <span className="wb-prow-loc">
        {baseName(p.path)}:{p.line}
      </span>
    </button>
  );

  return (
    <div className="wb-panel-body">
      {problems.length > 0 && (
        <div className="wb-problems-bar">
          {FILTERS.map((f) => {
            const n = f.key === "all" ? problems.length : problems.filter((p) => p.severity === f.key).length;
            return (
              <button
                key={f.key}
                type="button"
                className="wb-pfilter"
                data-active={filter === f.key || undefined}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                {n > 0 && <span className="wb-pfilter-n">{n}</span>}
              </button>
            );
          })}
          <span className="wb-problems-sp" />
          <button
            type="button"
            className="wb-status-btn"
            data-active={grouped || undefined}
            title="按文件分组显示"
            onClick={() => setGrouped((g) => !g)}
          >
            按文件分组
          </button>
          <button
            type="button"
            className="wb-status-btn"
            title={`复制当前列表（${shown.length} 条）`}
            disabled={shown.length === 0}
            onClick={() =>
              void copyText(
                formatProblems(shown),
                () => toast(`已复制 ${shown.length} 条问题`, "success"),
                () => toast("复制失败：剪贴板不可用", "error"),
              )
            }
          >
            复制全部
          </button>
        </div>
      )}

      {running && <div className="wb-panel-note">正在编译…</div>}
      {!running && !compiled && problems.length === 0 && (
        <div className="wb-panel-note">还没有编译过。点「编译」后这里列出问题。</div>
      )}
      {compiled && problems.length === 0 && diags.length === 0 && (
        <div className="wb-panel-note">没有发现问题</div>
      )}
      {problems.length > 0 && shown.length === 0 && (
        <div className="wb-panel-note">
          没有符合筛选的问题
          <button type="button" className="wb-status-btn" onClick={() => setFilter("all")}>
            显示全部
          </button>
        </div>
      )}

      {grouped
        ? groups.map((g) => (
            <div key={g.path}>
              <div className="wb-pgroup-head" title={g.path}>
                {baseName(g.path)}
                <span className="wb-pgroup-n">{g.items.length}</span>
              </div>
              {g.items.map((p, i) => row(p, `${g.path}|${p.line}|${i}`))}
            </div>
          ))
        : shown.map((p, i) => row(p, `${p.path}|${p.line}|${i}`))}

      {diags.map((d, i) => (
        // 不可点：源码可能在关联工程里（工作区之外），点开会被路径守卫挡住，
        // 与其弹个错不如把路径摆出来让人自己去看
        <div key={`d${i}`} className="wb-prow wb-diag" data-kind={d.kind}>
          <Icon name="info" size={14} className="wb-prow-warn" />
          <span className="wb-prow-msg">
            {d.message}
            {d.file && <span className="wb-diag-path">{d.file}</span>}
          </span>
          <span className="wb-prow-loc">{d.project}</span>
        </div>
      ))}

      {problems.some((p) => p.source === "inspect") && (
        <div className="wb-panel-note">
          代码检查来自 jdt.ls，只覆盖打开着的文件（{problems.filter((p) => p.source === "inspect").length} 条）
        </div>
      )}
    </div>
  );
}
