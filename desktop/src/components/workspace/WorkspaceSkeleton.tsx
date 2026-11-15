import type { ReactNode } from "react";
import { Skeleton } from "../ui/Skeleton";
import { useDelayedBusy } from "../../hooks/useDelayedBusy";
import { DockRegion, useWorkbenchDock } from "./WorkbenchDock";
import { useFileSlot } from "./useFileSlot";
import { useWorkbenchLayout } from "../../lib/workbenchLayout";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { useViewActive } from "../../lib/viewActivity";
import "../../workspace-loading.css";

const labels: Record<string, string> = { files: "代码", db: "数据库", svn: "版本控制", meta: "元数据", logs: "日志排查", settings: "设置" };
function Lines({ count = 8, code = false }: { count?: number; code?: boolean }) {
  return <div className={`wb-loading-lines${code ? " wb-loading-code" : ""}`}>
    {Array.from({ length: count }, (_, i) => <div className="wb-loading-row" key={i}>
      {code && <Skeleton className="wb-loading-gutter" />}<Skeleton style={{ width: `${[64, 42, 78, 53, 35, 70][i % 6]}%` }} />
    </div>)}
  </div>;
}
function Bar({ tabs = false }: { tabs?: boolean }) {
  return <div className={`wb-loading-bar${tabs ? " wb-loading-tabs" : ""}`}><Skeleton className="wb-loading-label" /><Skeleton className="wb-loading-action" /><Skeleton className="wb-loading-icon" /></div>;
}
function Sidebar({ page }: { page: string }) {
  return <div className={`wb-loading-sidebar wb-loading-sidebar-${page}`} aria-hidden="true">
    {page !== "settings" && <><Bar /><div className="wb-loading-search"><Skeleton /></div></>}
    {page === "settings" && <Skeleton className="wb-loading-group" />}
    <Lines count={page === "settings" ? 11 : 12} />
  </div>;
}
function Content({ page }: { page: string }) {
  if (page === "db") return <><Bar /><div className="wb-loading-query"><Lines count={4} code /></div><Bar tabs /><Bar /><div className="wb-loading-grid"><Bar /><Lines count={7} /></div></>;
  if (page === "settings") return <><Bar /><div className="wb-loading-settings"><Skeleton className="wb-loading-title" /><Skeleton className="wb-loading-description" />
    <div className="wb-loading-setting-group">{[0, 1, 2, 3].map(i => <div key={i} className="wb-loading-setting"><div><Skeleton className="wb-loading-label" /><Skeleton className="wb-loading-description" /></div><Skeleton className="wb-loading-action" /></div>)}<Skeleton className="wb-loading-setting-preview" /></div>
  </div></>;
  if (page === "meta") return <div className="wb-loading-meta"><Sidebar page="meta" /><div className="wb-loading-pane"><Bar /><div className="wb-loading-empty"><Skeleton className="wb-loading-empty-icon" /><Skeleton className="wb-loading-description" /></div></div></div>;
  if (page === "logs") return <><Bar /><Bar /><div className="wb-loading-logs"><div><Lines count={10} /></div><div className="wb-loading-pane"><div className="wb-loading-empty"><Skeleton className="wb-loading-label" /><Skeleton className="wb-loading-description" /></div></div></div></>;
  return <><Bar /><div className="wb-loading-pane"><div className="wb-loading-empty"><Skeleton className="wb-loading-empty-icon" /><Skeleton className="wb-loading-description" /></div></div></>;
}

/** Placeholders use the same dock hosts as their page; loading never adds another row below the workbench. */
export function WorkspaceSkeleton({ page }: { page: string }) {
  const visible = useDelayedBusy(true), dock = useWorkbenchDock(), slot = useFileSlot();
  const layout = useWorkbenchLayout(), panelOpen = useWorkspaceSelector(s => s.panelOpen), active = useViewActive();
  const frame = (children: ReactNode, announce = false, region = "document") => <div data-workspace-skeleton={page} data-loading-region={region} data-visible={visible || undefined} className={`wb-loading-page wb-loading-for-${page}`}>
    {announce && <span className="sr-only" role="status">正在打开{labels[page] ?? "工作区"}…</span>}
    <div className="wb-loading-visual" aria-hidden="true" aria-busy="true">{children}</div>
  </div>;
  if (page === "files") {
    if (!dock) return null;
    return <>
      {slot("tree", frame(<Sidebar page="files" />))}
      {slot("context", frame(<Bar />, false, "context"))}
      {slot("editor", frame(<><Bar tabs /><Bar /><Lines count={12} code /></>, true))}
      {active && panelOpen && slot("output", <div className="wb-panel" data-compact={layout.compact || undefined}>{frame(<Bar />, false, "toolbar")}</div>)}
      {slot("status", frame(<Bar />, false, "status"))}
    </>;
  }
  return <>
    {["db", "svn", "settings"].includes(page) && <DockRegion region="sidebar">{frame(<Sidebar page={page} />)}</DockRegion>}
    {page === "db" && <DockRegion region="doctabs">{frame(<Bar tabs />, false, "tabs")}</DockRegion>}
    {page === "svn" && <DockRegion region="toolbar">{frame(<Bar tabs />, false, "toolbar")}</DockRegion>}
    <DockRegion region="document">{frame(<Content page={page} />, true)}</DockRegion>
  </>;
}
