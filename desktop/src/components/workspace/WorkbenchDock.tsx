import { useViewActive } from "../../lib/viewActivity";
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IconName } from "../ui/icon";

export type DockRegionName = "toolbar" | "sidebar" | "document" | "bottom" | "actions" | "tabs";

/** 当前工具的「文档页」入口：作为一个标签排在文件标签后面。 */
export interface DockToolTab {
  label: string;
  icon: IconName;
  /** 工具自己画多个文档标签（停靠到 `tabs` 区），不用这一个固定标签。 */
  custom?: boolean;
}

export interface DockSlots {
  hosts: Record<DockRegionName, HTMLElement | null>;
  /** 把一个 DOM 节点登记为某个停靠区的宿主（底部面板在 FilesTab 里渲染，要自己挂上来）。 */
  bindHost: (name: DockRegionName) => (node: HTMLElement | null) => void;
  showDocument: () => void;
  showCode: () => void;
  documentOpen: boolean;
  toolTab: DockToolTab | null;
}
export const WorkbenchDockContext = createContext<DockSlots | null>(null);
export const useWorkbenchDock = () => useContext(WorkbenchDockContext);

/**
 * Tool ownership stays with its component; only its visual regions are docked.
 *
 * 底部区例外：它是统一面板里的一个标签（NC 服务日志），切到别的工具后日志仍要能看，
 * 所以不跟着工具的活动状态隐藏。
 */
export function DockRegion({ region, children }: { region: DockRegionName; children: ReactNode }) {
  const dock = useWorkbenchDock();
  const active = useViewActive();
  if (!dock) return <>{children}</>;
  const host = dock.hosts[region];
  const visible = active || region === "bottom";
  return host ? createPortal(<div className="wb-dock-region" hidden={!visible}>{children}</div>, host) : null;
}
