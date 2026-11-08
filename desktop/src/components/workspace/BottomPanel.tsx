import { useMemo } from "react";
import { Icon } from "../ui/icon";
import { missingResourceId } from "../../lib/resourceMissing";
import { ResourceDownloadButton } from "../resource/ResourceDownloadButton";
import { useWorkbenchDock } from "./WorkbenchDock";
import { ProblemsView } from "./ProblemsView";
import { BuildOutputView } from "./BuildOutputView";
import { CallHierarchyPanel } from "./CallHierarchyPanel";
import { TypeHierarchyPanel } from "./TypeHierarchyPanel";
import { TodoPanel } from "./TodoPanel";
import { BookmarkPanel } from "./BookmarkPanel";
import { DebugPanel } from "./DebugPanel";
import { useDebugSnapshot } from "../../lib/debugSession";
import { openCallHierarchy } from "../../lib/callHierarchy";
import { type CompileResult, type Problem } from "../../lib/compile";
import { setSession, useWorkspaceSelector } from "../../lib/workspaceSession";
import type { CodeDiag } from "../../lib/diagStore";
import type { BuildMaintenance } from "../../hooks/useBuildMaintenance";
import { countErrors, mergeProblems } from "../../lib/problemList";
import { DevelopmentFlowControl } from "../services/DevelopmentFlowControl";
import { useQueryClient } from "@tanstack/react-query";
import { PanelTabs } from "./PanelTabs";
import { revealWorkbenchPanel, updateWorkbenchLayout, useWorkbenchLayout } from "../../lib/workbenchLayout";

export type PanelTab = "problems" | "build" | "svc" | "calls" | "types" | "todo" | "bookmarks" | "debug";

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
  onOpenAt: (path: string, line: number, push?: boolean, column?: number) => void;
  /** jdt.ls 的代码检查（波浪线那批），与编译问题一起显示。 */
  inspect: CodeDiag[];
  onNextProblem: () => void;
  onPrevProblem: () => void;
  /** 取消正在跑的编译（一轮最坏 30 分钟，没有这个按钮用户只能杀进程）。 */
  onCancel: () => void;
  onClose: () => void;
  /** 当前文件（「构建操作」里清理/重编当前模块用）；单测可不传。 */
  activePath?: string | null;
  /** 清理 / 重编 / 重建索引入口；不传则编译输出页不显示工具条。 */
  build?: BuildMaintenance;
  /** 组合开发流程的编译入口，关闭该次隐式投送以保持步骤选择准确。 */
  compileAll?: () => Promise<boolean>;
}

/**
 * 底部面板：问题列表、编译输出、NC 服务（服务页把自己的卡片与日志停靠到「NC 服务」标签的宿主里）。
 * 搜索结果留在侧栏、SQL 结果留在 SQL 标签页——它们和各自的输入表单是一体的，拆出来反而来回跳。
 */
export function BottomPanel({ root, tab, onTab, running, result, log: logProp, onOpenProblem, onOpenAt, inspect, onNextProblem, onPrevProblem, onCancel, onClose, activePath = null, build, compileAll }: Props) {
  const queryClient = useQueryClient();
  const serviceExpanded = useWorkspaceSelector(s => !!s.serviceExpanded);
  const layout = useWorkbenchLayout();
  const sessionLog = useWorkspaceSelector((s) => s.compileLog);
  const compileResourceMissing = useWorkspaceSelector((s) => s.compileResourceMissing);
  // 树右键「查看该文件的问题」设置的路径过滤；面板卸载/切换页签后仍保留
  const problemsPath = useWorkspaceSelector((s) => s.problemsPath);
  const problemsPathScope = useWorkspaceSelector(s => s.problemsPathScope);
  const log = logProp ?? sessionLog;
  // 标签上的小灯：调试停在某一行时，没开面板也能看到「现在断住了」
  const debug = useDebugSnapshot();
  const dock = useWorkbenchDock();

  // D4 诊断：ecj 原文之外的推断（有源码没产物 / 工程被停用 / 产物比源码旧）。
  // 单独一段显示，不算进错误数——它是「为什么编不过」的解释，不是又一条报错。
  const diags = result?.diagnostics ?? [];
  // 徽章与「上/下一处」用合并后的口径：编译问题与代码检查经常指的是同一处，
  // 分开数会让数字和列表长度对不上
  const merged = useMemo(() => mergeProblems(result?.problems, inspect), [result?.problems, inspect]);
  const errors = countErrors(merged);

  const expanded = layout.expanded === tab || tab === "svc" && serviceExpanded;
  const compact = layout.compact && layout.mode === "code" && tab === "problems" && !running && !result && !merged.length && !diags.length && !compileResourceMissing && !log.length;
  const toggleExpanded = () => { revealWorkbenchPanel(tab); updateWorkbenchLayout({ expanded: expanded ? null : tab }); setSession({ serviceExpanded: tab === "svc" && !expanded }); };

  return (
    <section className="wb-panel" data-compact={compact || undefined}>
      <div className="wb-panel-tabs">
        <PanelTabs tab={tab} onTab={onTab} errors={errors} paused={debug.anyPaused} />
        <span className="wb-status-sp" />
        {tab === "svc" && <DevelopmentFlowControl compileAll={compileAll} onChanged={() => { void queryClient.invalidateQueries({ queryKey: ["server-status"] }); void queryClient.invalidateQueries({ queryKey: ["client-status"] }); void queryClient.invalidateQueries({ queryKey: ["deploy-status"] }); }} />}
        <button type="button" className="wb-status-btn sc-expand-button" aria-pressed={expanded} onClick={toggleExpanded}><Icon name={expanded ? "collapse" : "expand"} size={16} />{expanded ? "恢复布局" : "展开阅读"}</button>
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
        <button type="button" className="wb-icon-btn" title="关闭面板" aria-label="关闭面板" onClick={() => { updateWorkbenchLayout({ expanded: null }); setSession({ serviceExpanded: false }); onClose(); }}>
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="wb-tabpanel" role="tabpanel" id="wb-panel-body" aria-labelledby={`wb-ptab-${tab}`} hidden={compact}>
      {(tab === "build" || tab === "problems") && !running && (compileResourceMissing || log.some(line => missingResourceId(line) === "ecj")) && <div className="wb-banner"><span>缺少 Java 编译器，下载完成后请重新编译。</span><ResourceDownloadButton id="ecj" /></div>}
      {tab === "problems" && (
        <ProblemsView
          key={problemsPath ? `${problemsPathScope}:${problemsPath}` : "default"}
          root={root}
          activePath={activePath}
          result={result}
          problems={merged}
          diags={diags}
          running={running}
          compiled={result !== null}
          pathFilter={problemsPath}
          pathFilterScope={problemsPathScope}
          onClearPathFilter={() => setSession({ problemsPath: null, problemsPathScope: undefined })}
          onOpenProblem={onOpenProblem}
          onOpenAt={onOpenAt}
        />
      )}
      {tab === "build" && (
        <BuildOutputView
          root={root}
          log={log}
          result={result}
          activePath={activePath}
          onOpenProblem={onOpenProblem}
          onOpenAt={onOpenAt}
          build={build}
        />
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
