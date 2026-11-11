import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { returnFromService, toolReturnLabel, useToolReturn } from "../../lib/toolReturn";
import { Icon } from "../ui/icon";

export function ToolReturnEntry() {
  const flow = useToolReturn();
  const serviceVisible = useWorkspaceSelector(s => s.panelOpen && s.panelTab === "svc");
  if (flow.activeTool !== "logs" && flow.logExcursion) return <button type="button" className="ux-btn wb-tool-return"
    onClick={() => window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "logs" }))}><Icon name="arrowLeft" size={12} />返回日志排查</button>;
  if (flow.activeTool === "files" && serviceVisible && flow.service) return <button type="button" className="ux-btn wb-tool-return"
    onClick={returnFromService}><Icon name="arrowLeft" size={12} />返回{toolReturnLabel(flow.service)}</button>;
  return null;
}
