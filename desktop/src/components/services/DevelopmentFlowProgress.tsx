import { useQuery } from "@tanstack/react-query";
import { useDevelopmentFlow } from "../../hooks/useDevelopmentFlow";
import { useAppHidden } from "../../lib/appVisibility";
import { useViewActive } from "../../lib/viewActivity";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { sameDevelopmentRoot } from "../../lib/developmentFlow";
import { Icon } from "../ui/icon";
import "../../development-flow.css";

export function DevelopmentFlowProgress({ onChanged }: { onChanged?: () => void }) {
  const flow = useDevelopmentFlow(onChanged), hidden = useAppHidden(), viewActive = useViewActive();
  const panelVisible = useWorkspaceSelector((s) => s.panelOpen && s.panelTab === "svc");
  const visible = !hidden && viewActive && panelVisible;
  // 只刷新可见时钟，单次成本 O(1)；没有 IPC，面板隐藏或流程结束即停。
  const clock = useQuery({ queryKey: ["development-elapsed"], queryFn: () => Date.now(), enabled: visible && flow.running, refetchInterval: visible && flow.running ? 1000 : false });
  const snapshot = flow.snapshot;
  if (!sameDevelopmentRoot(flow.root, snapshot.root ?? "") || !["running", "cancelling", "failed", "cancelled"].includes(snapshot.state)) return null;
  const seconds = Math.max(0, Math.floor(((clock.data ?? Date.now()) - (snapshot.startedAt ?? Date.now())) / 1000));
  return <div className="development-progress" data-state={snapshot.state} role="status">
    <Icon name={flow.running ? "spinner" : snapshot.state === "failed" ? "alertTriangle" : "info"} size={14} className={flow.running ? "animate-spin" : ""} />
    <span className="development-phase" title={snapshot.detail || snapshot.phase}>{flow.running ? snapshot.phase : snapshot.detail}</span>
    {flow.running && <span className="development-elapsed">已用 {seconds} 秒</span>}
    {flow.running ? <button type="button" className="sv-btn" disabled={snapshot.state === "cancelling"} onClick={() => void flow.cancel().catch(() => {})}>{snapshot.state === "cancelling" ? "取消中…" : "取消流程"}</button> : <button type="button" className="sv-icon-btn" aria-label="关闭开发流程结果" onClick={flow.dismiss}><Icon name="close" size={13} /></button>}
  </div>;
}
