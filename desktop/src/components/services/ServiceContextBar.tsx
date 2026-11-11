import { useWorkspaceSelector, setSession } from "../../lib/workspaceSession";
import { updateWorkbenchLayout, useWorkbenchLayout } from "../../lib/workbenchLayout";
import { Icon } from "../ui/icon";

export function ServiceContextBar({ projectRoot, ncHome }: { projectRoot?: string | null; ncHome?: string | null }) {
  const root = useWorkspaceSelector(s => s.root);
  const project = projectRoot ?? root;
  const expanded = useWorkbenchLayout().expanded === "svc";
  return <div className="sc-context">
    <span title={project ?? undefined}>{project?.split(/[\\/]/).filter(Boolean).pop() || "未打开工程"}</span>
    <span className="sc-context-directory" title={ncHome ?? undefined}>{ncHome || "尚未读取 NC 环境"}</span>
    <span className="ux-spacer" />
    <button type="button" className="ux-btn" onClick={() => window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "logs" }))}><Icon name="log" size={13} />日志排查</button>
    <button type="button" className="ux-btn" aria-pressed={expanded} onClick={() => { updateWorkbenchLayout({ expanded: expanded ? null : "svc", compact: false }); setSession({ serviceExpanded: false }); }}><Icon name={expanded ? "collapse" : "expand"} size={13} />{expanded ? "恢复停靠" : "展开阅读"}</button>
  </div>;
}
