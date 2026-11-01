import { useEffect, useMemo, useRef } from "react";
import { Icon } from "../ui/icon";
import { baseName } from "../../lib/workspace";
import { useWorkbenchDock } from "./WorkbenchDock";
import { CallHierarchyPanel } from "./CallHierarchyPanel";
import { TodoPanel } from "./TodoPanel";
import { BookmarkPanel } from "./BookmarkPanel";
import { openCallHierarchy } from "../../lib/callHierarchy";
import { relativeTo, type CompileResult, type Problem } from "../../lib/compile";
import { parseLogLink } from "../../lib/logLink";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import type { CodeDiag } from "../../lib/diagStore";
import { countErrors, mergeProblems } from "../../lib/problemList";

export type PanelTab = "problems" | "build" | "svc" | "calls" | "todo" | "bookmarks";

interface Props {
  root: string;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  running: boolean;
  result: CompileResult | null;
  /**
   * 编译日志。不传就自己从会话里取。
   *
   * 编译期间这份数组每 80ms 换一次（后端逐行推、前端攒批刷）。由文件页当 prop
   * 传下来的话，文件页自己就得订阅它——于是每 80ms 整棵文件树、标签条、所有
   * 隐藏页面陪着重渲染一次。让它在这里订阅，刷新范围就只有这个面板。
   */
  log?: string[];
  onOpenProblem: (p: Problem) => void;
  /** 点日志里的报错行直接跳到那个文件的那一行。 */
  onOpenAt: (path: string, line: number) => void;
  /** jdt.ls 的代码检查（波浪线那批），与编译问题一起显示。 */
  inspect: CodeDiag[];
  onNextProblem: () => void;
  onPrevProblem: () => void;
  /** 取消正在跑的编译（一轮最坏 30 分钟，没有这个按钮用户只能杀进程）。 */
  onCancel: () => void;
  onClose: () => void;
}

/**
 * 底部面板：问题列表、编译输出、NC 服务（服务页把自己的卡片与日志停靠到「NC 服务」标签的宿主里）。
 * 搜索结果留在侧栏、SQL 结果留在 SQL 标签页——它们和各自的输入表单是一体的，拆出来反而来回跳。
 */
export function BottomPanel({ root, tab, onTab, running, result, log: logProp, onOpenProblem, onOpenAt, inspect, onNextProblem, onPrevProblem, onCancel, onClose }: Props) {
  const sessionLog = useWorkspaceSelector((s) => s.compileLog);
  const log = logProp ?? sessionLog;
  const dock = useWorkbenchDock();
  const logRef = useRef<HTMLDivElement>(null);
  // 只在用户本来就贴着底部时才跟随最新一行：首次建类索引会连续输出几十行，
  // 无条件贴底等于把正往上翻看的人一脚踹回底部。
  const follow = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [log, tab]);

  // 日志行的跳转目标。整批算一次而不是在 JSX 里逐行算：编译时会连续推几百行，
  // 每次渲染重跑一遍正则没必要。解析不出位置的行是 null，照原样显示成纯文本。
  const logLinks = useMemo(() => log.map((l) => parseLogLink(l, root)), [log, root]);

  const problems = result?.problems ?? [];
  // D4 诊断：ecj 原文之外的推断（有源码没产物 / 工程被停用 / 产物比源码旧）。
  // 单独一段显示，不算进错误数——它是「为什么编不过」的解释，不是又一条报错。
  const diags = result?.diagnostics ?? [];
  // 徽章与「上/下一处」用合并后的口径：编译问题与代码检查经常指的是同一处，
  // 分开数会让数字和列表长度对不上
  const merged = useMemo(() => mergeProblems(result?.problems, inspect), [result?.problems, inspect]);
  const errors = countErrors(merged);

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
        <button type="button" className="wb-ptab" data-active={tab === "calls" || undefined} onClick={() => onTab("calls")}>
          调用层级
        </button>
        <button type="button" className="wb-ptab" data-active={tab === "todo" || undefined} onClick={() => onTab("todo")}>
          待办
        </button>
        <button type="button" className="wb-ptab" data-active={tab === "bookmarks" || undefined} onClick={() => onTab("bookmarks")}>
          书签
        </button>
        <span className="wb-status-sp" />
        {tab === "problems" && merged.length > 0 && (
          <>
            <button type="button" className="wb-status-btn" title="跳到上一处问题" onClick={onPrevProblem}>
              上一处
            </button>
            <button type="button" className="wb-status-btn" title="跳到下一处问题" onClick={onNextProblem}>
              下一处
            </button>
          </>
        )}
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
          {!running && !result && inspect.length === 0 && <div className="wb-panel-note">还没有编译过。点「编译」后这里列出问题。</div>}
          {!running && result && problems.length === 0 && diags.length === 0 && inspect.length === 0 && (
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
          {inspect.length > 0 && (
            <>
              {/* 代码检查来自 jdt.ls，只有**打开着**的文件才有：它和编译问题的范围不同，
                  所以单独一段并写清来源，别让人误以为「编译器也报了这条」 */}
              <div className="wb-panel-note">代码检查（jdt.ls · 打开的文件 · {inspect.length} 条，点一行跳过去）</div>
              {inspect.map((d, i) => (
                <button
                  type="button"
                  key={`i${i}`}
                  className="wb-prow"
                  title={`${d.path}:${d.line}`}
                  onClick={() => onOpenAt(d.path, d.line)}
                >
                  {/* 三档配色：info（未使用的导入、命名建议）用弱化色和 info 图标，
                      它是提示，不该和警告一样醒目 */}
                  <Icon
                    name={d.severity === "info" ? "info" : "alertTriangle"}
                    size={14}
                    className={
                      d.severity === "error"
                        ? "wb-prow-err"
                        : d.severity === "info"
                          ? "wb-prow-info"
                          : "wb-prow-warn"
                    }
                  />
                  <span className="wb-prow-msg">{d.message}</span>
                  <span className="wb-prow-loc">
                    {baseName(d.path)}:{d.line}
                  </span>
                </button>
              ))}
            </>
          )}
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
          {log.map((l, i) => {
            const link = logLinks[i];
            // 能解析出「文件:行」的行做成按钮：编译器说哪儿错了，就该直接点到哪儿，
            // 不用自己再去树上找那个文件
            return link ? (
              <button
                type="button"
                key={i}
                className="wb-log-link"
                title={`${link.path}:${link.line}`}
                onClick={() => onOpenAt(link.path, link.line)}
              >
                {l}
              </button>
            ) : (
              <div key={i}>{l}</div>
            );
          })}
          {result && (
            <>
              {result.problems
                .filter((p) => p.severity === "error")
                .map((p, i) => (
                  <button
                    type="button"
                    key={`e${i}`}
                    className="wb-log-link"
                    title={`${p.file}:${p.line}`}
                    onClick={() => onOpenProblem(p)}
                  >
                    <span className="wb-log-er">ERROR</span> {relativeTo(root, p.file)}:{p.line} {p.message}
                  </button>
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
      {tab === "calls" && <CallHierarchyPanel />}
      {tab === "calls" && (
        <div className="wb-panel-note">
          <button type="button" className="wb-status-btn" onClick={() => void openCallHierarchy()}>
            查当前光标处的调用层级
          </button>
        </div>
      )}
      {tab === "todo" && <TodoPanel root={root} onOpenAt={onOpenAt} />}
      {tab === "bookmarks" && <BookmarkPanel root={root} onOpenAt={onOpenAt} />}
      <div ref={dock?.bindHost("bottom")} className="wb-panel-body wb-svc-host" hidden={tab !== "svc"} />
    </section>
  );
}
