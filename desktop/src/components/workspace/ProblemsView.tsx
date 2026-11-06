import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { baseName, dirName } from "../../lib/workspace";
import { copyText } from "../../lib/utils";
import { compileSourceChanged } from "../../lib/compileFreshness";
import { moduleOf } from "../../lib/ncModule";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import type { CompileDiagnostic, CompileResult, Problem } from "../../lib/compile";
import { filterProblems, formatProblems, groupProblems, type ProblemFilter, type UnifiedProblem } from "../../lib/problemList";
import { problemsAtPath, scopeProblems, type DiagnosticScope, type ProblemPathScope } from "../../lib/diagnosticScope";
import { ProblemRow } from "./ProblemRow";
import { ProblemDiagnostics } from "./ProblemDiagnostics";
import { SourceContextPreview } from "./SourceContextPreview";
import "../../diagnostic-workspace.css";

interface Props {
  problems: UnifiedProblem[];
  /** Cross-project build explanations remain independent of the error count and severity filter. */
  diags: CompileDiagnostic[];
  running: boolean;
  compiled: boolean;
  pathFilter?: string | null;
  pathFilterScope?: ProblemPathScope;
  onClearPathFilter?: () => void;
  root?: string | null;
  activePath?: string | null;
  result?: CompileResult | null;
  onOpenProblem: (p: Problem) => void;
  onOpenAt: (path: string, line: number, push?: boolean, column?: number) => void;
}
const FILTERS: { key: ProblemFilter; label: string }[] = [{ key: "all", label: "全部" }, { key: "error", label: "错误" }, { key: "warning", label: "警告" }, { key: "info", label: "提示" }];

export function ProblemsView({ problems, diags, running, compiled, pathFilter = null, pathFilterScope = "file", onClearPathFilter, root = null, activePath = null, result, onOpenProblem, onOpenAt }: Props) {
  const [filter, setFilter] = useState<ProblemFilter>("all");
  const [grouped, setGrouped] = useState(false);
  const [scope, setScope] = useState<DiagnosticScope>("project");
  const [selection, setSelection] = useState<{ problem: UnifiedProblem; root: string | null } | null>(null);
  const selected = selection?.root === root ? selection.problem : null;
  const setSelected = (problem: UnifiedProblem | null) => setSelection(problem ? { problem, root } : null);
  const tabs = useWorkspaceSelector(s => s.tabs);
  const currentModule = root && activePath ? moduleOf(root, dirName(activePath)) : null;
  const scoped = pathFilter ? problemsAtPath(problems, pathFilter, pathFilterScope) : scopeProblems(problems, scope, root, activePath);
  const shown = filterProblems(scoped, filter), groups = groupProblems(shown);
  const preview = selected && shown.includes(selected) ? selected : null;
  const changed = tabs.filter(t => compileSourceChanged(t, result));
  const open = (p: UnifiedProblem) => {
    if (p.column !== undefined) onOpenAt(p.path, p.line, true, p.column);
    else if (p.source === "inspect") onOpenAt(p.path, p.line);
    else onOpenProblem({ file: p.path, line: p.line, severity: p.severity === "info" ? "warning" : p.severity, message: p.message });
  };
  const row = (p: UnifiedProblem, key: string) => <ProblemRow key={key} problem={p} selected={preview === p} onOpen={() => open(p)} onPreview={() => setSelected(selected === p ? null : p)} />;
  return <div className="dw-problems-shell">
    <div className="dw-problem-scopes">
      <label>范围 <select aria-label="问题范围" value={scope} disabled={!!pathFilter} onChange={event => { setScope(event.target.value as DiagnosticScope); setSelected(null); }}>
        <option value="project">工程结果</option><option value="module" disabled={!currentModule}>当前模块{currentModule ? ` · ${currentModule}` : ""}</option><option value="file" disabled={!activePath}>当前文件</option>
      </select></label>
      <span className="dw-problem-freshness">{compiled ? result?.completedAtMs ? `编译结果 ${new Date(result.completedAtMs).toLocaleTimeString()}` : "最近一次编译结果" : "代码检查与编译问题"}</span>
      {changed.length > 0 && compiled && <span className="dw-problem-stale" title="编译读取磁盘版本；未保存草稿或编译后再次保存的文件需要重新编译确认。">{changed.length} 个文件需核对新版本</span>}
    </div>
    <div className="wb-panel-body">
      {pathFilter && <div className="wb-problems-scope"><Icon name="file" size={12} /><span className="wb-prow-msg">仅看 <b title={pathFilter}>{baseName(pathFilter)}</b> 的问题</span><span className="wb-pfilter-n">{scoped.length}</span><span className="wb-problems-sp" /><button type="button" className="wb-status-btn" title="清除路径过滤，显示整个工程的问题" onClick={() => { setScope("project"); onClearPathFilter?.(); }}>显示全部文件</button></div>}
      {problems.length > 0 && <div className="wb-problems-bar">
        {FILTERS.map(f => { const n = f.key === "all" ? scoped.length : scoped.filter(p => p.severity === f.key).length; return <button key={f.key} type="button" className="wb-pfilter" data-active={filter === f.key || undefined} onClick={() => setFilter(f.key)}>{f.label}{n > 0 && <span className="wb-pfilter-n">{n}</span>}</button>; })}
        <span className="wb-problems-sp" /><button type="button" className="wb-status-btn" data-active={grouped || undefined} title="按文件分组显示" onClick={() => setGrouped(g => !g)}>按文件分组</button>
        <button type="button" className="wb-status-btn" title={`复制当前列表（${shown.length} 条）`} disabled={!shown.length} onClick={() => void copyText(formatProblems(shown), () => toast(`已复制 ${shown.length} 条问题`, "success"), () => toast("复制失败：剪贴板不可用", "error"))}>复制全部</button>
      </div>}
      {running && <div className="wb-panel-note" role="status">正在编译…上次结果保留供查看</div>}
      {!running && !compiled && !problems.length && !pathFilter && <div className="wb-panel-note">还没有编译过。点「编译」后这里列出问题。</div>}
      {compiled && !problems.length && !diags.length && !pathFilter && <div className="wb-panel-note">没有发现问题</div>}
      {pathFilter && !scoped.length && <div className="wb-panel-note">{pathFilterScope === "file" ? "该文件没有问题了" : "该分支没有问题了"}<button type="button" className="wb-status-btn" onClick={() => { setScope("project"); onClearPathFilter?.(); }}>显示全部文件</button></div>}
      {!pathFilter && problems.length > 0 && !scoped.length && <div className="wb-panel-note">当前范围没有问题<button type="button" className="wb-status-btn" onClick={() => setScope("project")}>查看工程结果</button></div>}
      {scoped.length > 0 && !shown.length && <div className="wb-panel-note">没有符合筛选的问题<button type="button" className="wb-status-btn" onClick={() => setFilter("all")}>显示全部</button></div>}
      {grouped ? groups.map(g => <div key={g.path}><div className="wb-pgroup-head" title={g.path}>{baseName(g.path)}<span className="wb-pgroup-n">{g.items.length}</span></div>{g.items.map((p, i) => row(p, `${g.path}|${p.line}|${i}`))}</div>) : shown.map((p, i) => row(p, `${p.path}|${p.line}|${i}`))}
      <ProblemDiagnostics diags={diags} />
      {problems.some(p => p.source === "inspect" || p.alsoInspected) && <div className="wb-panel-note">代码检查来自 jdt.ls，只覆盖打开着的文件（{problems.filter(p => p.source === "inspect" || p.alsoInspected).length} 条）</div>}
    </div>
    {preview && <SourceContextPreview path={preview.path} line={preview.line} identity={root} onOpen={() => open(preview)} onClose={() => setSelected(null)} />}
  </div>;
}
