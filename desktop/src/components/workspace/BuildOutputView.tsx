import { useState } from "react";
import { relativeTo, type CompileResult, type ModuleBuildResult, type Problem } from "../../lib/compile";
import { dirName } from "../../lib/workspace";
import { moduleOf } from "../../lib/ncModule";
import { isJavaFile } from "../../lib/autoCompile";
import type { BuildMaintenance } from "../../hooks/useBuildMaintenance";
import { BuildActions } from "./BuildActions";
import { BuildRawLog } from "./BuildRawLog";
import "../../diagnostic-workspace.css";

const STATUS_LABEL: Record<ModuleBuildResult["status"], string> = { ok: "成功", failed: "失败", blocked: "被阻断", skipped: "跳过", cleaned: "已清理" };
type Section = "summary" | "problems" | "raw";

/** Structured results and continuous raw output have separate reading positions. */
export function BuildOutputView({ root, log, result, activePath, onOpenProblem, onOpenAt, build }: {
  root: string; log: string[]; result: CompileResult | null; activePath: string | null;
  onOpenProblem: (p: Problem) => void; onOpenAt: (path: string, line: number) => void; build?: BuildMaintenance;
}) {
  const [section, setSection] = useState<Section>("summary");
  const modules = result?.modules ?? [];
  const notOk = modules.filter(m => m.status === "failed" || m.status === "blocked").length;
  const modulePath = activePath && !activePath.includes("://") && isJavaFile(activePath) ? activePath : null;
  const activeModule = modulePath ? moduleOf(root, dirName(modulePath)) : null;
  return <div className="wb-build">
    <div className="dw-build-nav" aria-label="编译输出层次">
      <button type="button" aria-pressed={section === "summary"} onClick={() => setSection("summary")}>模块摘要{modules.length > 0 ? ` · ${modules.length}` : ""}</button>
      <button type="button" aria-pressed={section === "problems"} onClick={() => setSection("problems")}>问题定位{result?.problems.length ? ` · ${result.problems.length}` : ""}</button>
      <button type="button" aria-pressed={section === "raw"} onClick={() => setSection("raw")}>原始输出 · {log.length}</button>
      <span className="wb-status-sp" />
      {build && <BuildActions build={build} modulePath={modulePath} activeModule={activeModule} />}
    </div>
    <section className="dw-build-section" hidden={section !== "summary"} aria-label="模块构建摘要">
      {result ? <div className="dw-build-heading">
        <strong className={result.ok && result.errorCount === 0 ? "wb-log-ok" : "wb-log-er"}>{result.ok && result.errorCount === 0 ? "编译成功" : `编译未通过 · ${result.errorCount} 个错误`}</strong>
        <span>{result.sourceCount} 个源文件 · {(result.durationMs / 1000).toFixed(1)}s{result.completedAtMs ? ` · ${new Date(result.completedAtMs).toLocaleTimeString()}` : ""}</span>
      </div> : <div className="wb-panel-note">还没有编译结果；构建过程可查看原始输出。</div>}
      {notOk > 0 && <div className="wb-panel-note wb-log-er">{notOk} 个模块未通过，请查看原因或问题定位。</div>}
      {modules.length > 0 && <div className="wb-build-ledger" role="list" aria-label="模块构建结果">{modules.map(m => <div key={m.module} role="listitem" className="wb-build-row" data-status={m.status} title={m.reason ?? undefined}>
        <span className="wb-build-mod">{m.module}</span><span className="wb-build-state">{STATUS_LABEL[m.status] ?? m.status}</span>
        <span className="wb-build-meta">{[m.errorCount > 0 && `${m.errorCount} 个错误`, m.cleaned > 0 && `清理 ${m.cleaned} 个`, m.sourceCount > 0 && `${m.sourceCount} 个源文件`, m.durationMs > 0 && `${(m.durationMs / 1000).toFixed(1)}s`].filter(Boolean).join(" · ")}</span>
        {m.reason && <span className="wb-build-reason">{m.reason}</span>}
      </div>)}</div>}
      {result && <div className="wb-panel-note dw-build-outdir">输出目录 <span title={result.outDir}>{result.outDir}</span></div>}
    </section>
    <section className="dw-build-section" hidden={section !== "problems"} aria-label="编译问题定位">
      {!result?.problems.length && <div className="wb-panel-note">{result ? "本次编译没有源码问题；未通过的模块请查看模块摘要。" : "还没有编译结果"}</div>}
      {result?.problems.map((p, i) => <button type="button" key={`${p.file}:${p.line}:${i}`} className="wb-log-link dw-build-problem" title={`${p.file}:${p.line}`} onClick={() => onOpenProblem(p)}><span className={p.severity === "error" ? "wb-log-er" : "wb-log-mu"}>{p.severity === "error" ? "错误" : "警告"}</span> {relativeTo(root, p.file)}:{p.line} {p.message}</button>)}
    </section>
    <section className="dw-build-section" hidden={section !== "raw"} aria-label="原始编译日志">
      <BuildRawLog log={log} root={root} onOpenAt={onOpenAt} />
    </section>
  </div>;
}
