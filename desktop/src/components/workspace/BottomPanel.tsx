import { useEffect, useRef } from "react";
import { Icon } from "../ui/icon";
import { baseName } from "../../lib/workspace";
import { relativeTo, type CompileResult, type Problem } from "../../lib/compile";

export type PanelTab = "problems" | "build";

interface Props {
  root: string;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  running: boolean;
  result: CompileResult | null;
  log: string[];
  onOpenProblem: (p: Problem) => void;
  onClose: () => void;
}

/** 底部面板：问题列表与编译输出。其余标签（NC 日志/SQL/补丁）随对应里程碑加入。 */
export function BottomPanel({ root, tab, onTab, running, result, log, onOpenProblem, onClose }: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 编译输出跟随最新一行
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, tab]);

  const problems = result?.problems ?? [];
  const errors = result?.errorCount ?? 0;

  return (
    <section className="wb-panel">
      <div className="wb-panel-tabs">
        <button type="button" className="wb-ptab" data-active={tab === "problems" || undefined} onClick={() => onTab("problems")}>
          问题
          {errors > 0 && <span className="wb-ptab-n">{errors}</span>}
        </button>
        <button type="button" className="wb-ptab" data-active={tab === "build" || undefined} onClick={() => onTab("build")}>
          编译输出
        </button>
        <span className="wb-status-sp" />
        <button type="button" className="wb-icon-btn" title="关闭面板" aria-label="关闭面板" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>

      {tab === "problems" ? (
        <div className="wb-panel-body">
          {running && <div className="wb-panel-note">正在编译…</div>}
          {!running && !result && <div className="wb-panel-note">还没有编译过。点「编译」后这里列出问题。</div>}
          {!running && result && problems.length === 0 && <div className="wb-panel-note">没有发现问题</div>}
          {problems.map((p, i) => (
            <button type="button" key={i} className="wb-prow" onClick={() => onOpenProblem(p)} title={p.file}>
              <Icon name="alertTriangle" size={14} className={p.severity === "error" ? "wb-prow-err" : "wb-prow-warn"} />
              <span className="wb-prow-msg">{p.message}</span>
              <span className="wb-prow-loc">
                {baseName(p.file)}:{p.line}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="wb-panel-body wb-log" ref={logRef}>
          {log.length === 0 && <span className="wb-log-mu">还没有编译输出</span>}
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          {result && (
            <>
              {result.problems
                .filter((p) => p.severity === "error")
                .map((p, i) => (
                  <div key={`e${i}`}>
                    <span className="wb-log-er">ERROR</span> {relativeTo(root, p.file)}:{p.line} {p.message}
                  </div>
                ))}
              <div className={result.errorCount === 0 ? "wb-log-ok" : "wb-log-er"}>
                {result.errorCount === 0 ? "编译成功" : `编译完成，${result.errorCount} 个错误（有错误的文件不生成 class）`}
                <span className="wb-log-mu">
                  {" "}
                  · {result.sourceCount} 个源文件 · {(result.durationMs / 1000).toFixed(1)}s · 输出 {result.outDir}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
