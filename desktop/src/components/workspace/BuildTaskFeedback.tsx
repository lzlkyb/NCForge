import { useOperation } from "../../lib/operations";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { ViewActivityContext, useViewActive } from "../../lib/viewActivity";
import { Button } from "../ui/button";
import { TaskFeedback } from "../ui/TaskFeedback";

/** Subscribe here so the second clock never rerenders the log or module ledger. */
export function BuildTaskFeedback({ root, resultCompletedAt, onShowLog }: { root: string; resultCompletedAt?: number; onShowLog: () => void }) {
  const compiling = useWorkspaceSelector(s => s.compiling && s.root === root);
  const progress = useWorkspaceSelector(s => s.buildProgress);
  const visible = useWorkspaceSelector(s => s.panelOpen && s.panelTab === "build");
  const parentActive = useViewActive();
  const latest = useOperation("compile.manual");
  const operation = latest?.scope === root ? latest : null;
  const pending = !!operation && operation.endedAt === undefined;
  const current = pending ? operation : null;
  const active = compiling || pending;
  const failed = !active && operation && ["failed", "cancelled"].includes(operation.state)
    && (!resultCompletedAt || (operation.endedAt ?? 0) >= resultCompletedAt);
  return <ViewActivityContext.Provider value={visible && parentActive}>
    <TaskFeedback active={active} compact className="dw-build-task"
      label={progress?.phase || current?.phase || "正在编译工程…"}
      operationKey={current?.id ?? root} startedAt={current?.startedAt}
      cancelling={current?.state === "cancelling"}
      detail={current?.detail || (progress?.module ? `当前模块：${progress.module}` : "可切换页面继续工作；取消入口在编译工具栏。")}
      progress={progress ? { done: progress.done, total: progress.total, unit: "个模块" } : undefined}>
      <Button type="button" size="sm" variant="ghost" onClick={onShowLog}>查看原始输出</Button>
    </TaskFeedback>
    {failed && <div className="wb-panel-note" role="status">
      {operation.state === "cancelled" ? "本轮编译已取消" : "本轮编译未完成"}{operation.detail ? ` · ${operation.detail}` : ""}
    </div>}
  </ViewActivityContext.Provider>;
}
