import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { Icon } from "../ui/icon";
import { missingResourceId } from "../../lib/resourceMissing";
import { ResourceDownloadButton } from "../resource/ResourceDownloadButton";
import { useWorkbenchDock } from "./WorkbenchDock";
import { ProblemsView } from "./ProblemsView";
import { CallHierarchyPanel } from "./CallHierarchyPanel";
import { TypeHierarchyPanel } from "./TypeHierarchyPanel";
import { TodoPanel } from "./TodoPanel";
import { BookmarkPanel } from "./BookmarkPanel";
import { DebugPanel } from "./DebugPanel";
import { useDebugSnapshot } from "../../lib/debugSession";
import { openCallHierarchy } from "../../lib/callHierarchy";
import { relativeTo, type CompileResult, type Problem } from "../../lib/compile";
import { parseLogLink } from "../../lib/logLink";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import type { CodeDiag } from "../../lib/diagStore";
import { countErrors, mergeProblems } from "../../lib/problemList";

export type PanelTab = "problems" | "build" | "svc" | "calls" | "types" | "todo" | "bookmarks" | "debug";

const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: "problems", label: "问题" },
  { id: "build", label: "编译输出" },
  { id: "svc", label: "NC 服务" },
  { id: "calls", label: "调用层级" },
  { id: "types", label: "类型层级" },
  { id: "todo", label: "待办" },
  { id: "bookmarks", label: "书签" },
  { id: "debug", label: "调试" },
];

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
  const compileResourceMissing = useWorkspaceSelector((s) => s.compileResourceMissing);
  const log = logProp ?? sessionLog;
  // 标签上的小灯：调试停在某一行时，没开面板也能看到「现在断住了」
  const debug = useDebugSnapshot();
  const dock = useWorkbenchDock();
  const logRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
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

  // D4 诊断：ecj 原文之外的推断（有源码没产物 / 工程被停用 / 产物比源码旧）。
  // 单独一段显示，不算进错误数——它是「为什么编不过」的解释，不是又一条报错。
  const diags = result?.diagnostics ?? [];
  // 徽章与「上/下一处」用合并后的口径：编译问题与代码检查经常指的是同一处，
  // 分开数会让数字和列表长度对不上
  const merged = useMemo(() => mergeProblems(result?.problems, inspect), [result?.problems, inspect]);
  const errors = countErrors(merged);

  // 页签条走标准 tablist 键盘约定：左右键循环、Home/End 到两端，焦点与选中同步移动。
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = PANEL_TABS.findIndex((t) => t.id === tab);
    const n = PANEL_TABS.length;
    const next =
      e.key === "ArrowLeft"
        ? (i - 1 + n) % n
        : e.key === "ArrowRight"
          ? (i + 1) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    onTab(PANEL_TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="wb-panel">
      <div className="wb-panel-tabs">
        <div className="wb-ptabs" role="tablist" aria-label="底部面板" onKeyDown={onTabKeyDown}>
          {PANEL_TABS.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`wb-ptab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="wb-panel-body"
              tabIndex={tab === t.id ? 0 : -1}
              className="wb-ptab"
              data-active={tab === t.id || undefined}
              onClick={() => onTab(t.id)}
            >
              {t.label}
              {t.id === "problems" && errors > 0 && <span className="wb-ptab-n">{errors}</span>}
              {t.id === "debug" && debug.anyPaused && <span className="wb-ptab-live" title="调试已暂停（中间件或客户端）" />}
            </button>
          ))}
        </div>
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

      <div className="wb-tabpanel" role="tabpanel" id="wb-panel-body" aria-labelledby={`wb-ptab-${tab}`}>
      {(tab === "build" || tab === "problems") && !running && (compileResourceMissing || log.some(line => missingResourceId(line) === "ecj")) && <div className="wb-banner"><span>缺少 Java 编译器，下载完成后请重新编译。</span><ResourceDownloadButton id="ecj" /></div>}
      {tab === "problems" && (
        <ProblemsView
          problems={merged}
          diags={diags}
          running={running}
          compiled={result !== null}
          onOpenProblem={onOpenProblem}
          onOpenAt={onOpenAt}
        />
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
      {tab === "types" && <TypeHierarchyPanel />}
      {tab === "todo" && <TodoPanel root={root} onOpenAt={onOpenAt} />}
      {tab === "bookmarks" && <BookmarkPanel root={root} onOpenAt={onOpenAt} />}
      {tab === "debug" && <DebugPanel onOpenAt={onOpenAt} />}
      <div ref={dock?.bindHost("bottom")} className="wb-panel-body wb-svc-host" hidden={tab !== "svc"} />
      </div>
    </section>
  );
}
