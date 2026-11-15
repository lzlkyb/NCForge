import { useDevelopmentFlow } from "../../hooks/useDevelopmentFlow";
import { useAppHidden } from "../../lib/appVisibility";
import { ViewActivityContext } from "../../lib/viewActivity";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { sameDevelopmentRoot } from "../../lib/developmentFlow";
import { Icon } from "../ui/icon";
import { TaskFeedback } from "../ui/TaskFeedback";
import "../../development-flow.css";

export function DevelopmentFlowProgress({ onChanged }: { onChanged?: () => void }) {
  const flow = useDevelopmentFlow(onChanged), hidden = useAppHidden();
  const panelVisible = useWorkspaceSelector((s) => s.panelOpen && s.panelTab === "svc");
  const visible = !hidden && panelVisible;
  const snapshot = flow.snapshot;
  if (!sameDevelopmentRoot(flow.root, snapshot.root ?? "") || snapshot.state === "idle") return null;
  return <div className="development-progress" data-state={snapshot.state}>
    {/* 服务槽位也会独立隐藏，计时应随槽位停下，后台流程仍继续。 */}
    <ViewActivityContext.Provider value={visible}>
      <TaskFeedback active={flow.running} compact className="development-task" label={snapshot.phase || "正在执行开发流程…"}
        detail={snapshot.detail || undefined} startedAt={snapshot.startedAt ?? undefined} operationKey={snapshot.operationId ?? undefined}
        cancelling={snapshot.state === "cancelling"} cancelLabel="取消流程" onCancel={() => void flow.cancel().catch(() => {})} />
    </ViewActivityContext.Provider>
    {!flow.running && <>
      <Icon name={snapshot.state === "failed" ? "alertTriangle" : snapshot.state === "success" ? "check" : "info"} size={14} aria-hidden="true" />
      <span className="development-phase" role="status">{snapshot.detail || snapshot.phase}</span>
      <button type="button" className="sv-icon-btn" aria-label="关闭开发流程结果" onClick={flow.dismiss}><Icon name="close" size={13} /></button>
    </>}
  </div>;
}
