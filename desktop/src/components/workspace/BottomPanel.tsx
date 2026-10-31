import { useEffect, useRef } from "react";
import { Icon } from "../ui/icon";
import { baseName } from "../../lib/workspace";
import { useWorkbenchDock } from "./WorkbenchDock";
import { relativeTo, type CompileResult, type Problem } from "../../lib/compile";

export type PanelTab = "problems" | "build" | "svc";

interface Props {
  root: string;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  running: boolean;
  result: CompileResult | null;
  log: string[];
  onOpenProblem: (p: Problem) => void;
  /** 取消正在跑的编译（一轮最坏 30 分钟，没有这个按钮用户只能杀进程）。 */
  onCancel: () => void;
  onClose: () => void;
}

/**
 * 底部面板：问题列表、编译输出、NC 服务（服务页把自己的卡片与日志停靠到「NC 服务」标签的宿主里）。
 * 搜索结果留在侧栏、SQL 结果留在 SQL 标签页——它们和各自的输入表单是一体的，拆出来反而来回跳。
 */
export function BottomPanel({ root, tab, onTab, running, result, log, onOpenProblem, onCancel, onClose }: Props) {
  const dock = useWorkbenchDock();
  const logRef = useRef<HTMLDivElement>(null);
  // 只在用户本来就贴着底部时才跟随最新一行：首次建类索引会连续输出几十行，
  // 无条件贴底等于把正往上翻看的人一脚踹回底部。
  const follow = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [log, tab]);

  const problems = result?.problems ?? [];
  // D4 诊断：ecj 原文之外的推断（有源码没产物 / 工程被停用 / 产物比源码旧）。
  // 单独一段显示，不算进错误数——它是「为什么编不过」的解释，不是又一条报错。
  const diags = result?.diagnostics ?? [];
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
        <button type="button" className="wb-ptab" data-active={tab === "svc" || undefined} onClick={() => onTab("svc")}>
          NC 服务
        </button>
        <span className="wb-status-sp" />
        {running && (
          <button
            type="button"
            className="wb-status-btn"
            title="终止本轮编译（ecj 子进程会被立刻杀掉）"
            onClick={onCancel}
          >
            取消编译
          </button>
        )}
        <button type="button" className="wb-icon-btn" title="关闭面板" aria-label="关闭面板" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>

      {tab === "problems" && (
        <div className="wb-panel-body">
          {running && <div className="wb-panel-note">正在编译…</div>}
          {!running && !result && <div className="wb-panel-note">还没有编译过。点「编译」后这里列出问题。</div>}
          {!running && result && problems.length === 0 && diags.length === 0 && (
            <div className="wb-panel-note">没有发现问题</div>
          )}
          {problems.map((p, i) => (
            <button type="button" key={i} className="wb-prow" onClick={() => onOpenProblem(p)} title={p.file}>
              <Icon name="alertTriangle" size={14} className={p.severity === "error" ? "wb-prow-err" : "wb-prow-warn"} />
              <span className="wb-prow-msg">{p.message}</span>
              <span className="wb-prow-loc">
                {baseName(p.file)}:{p.line}
              </span>
            </button>
          ))}
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
        </div>
      )}
      {tab === "build" && (
        <div
          className="wb-panel-body wb-log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            // 距底 24px 内算「在看最新」，否则视为用户在往上翻
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
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
      <div ref={dock?.bindHost("bottom")} className="wb-panel-body wb-svc-host" hidden={tab !== "svc"} />
    </section>
  );
}
