import { useViewActive } from "../../lib/viewActivity";
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IconName } from "../ui/icon";

export type DockRegionName = "toolbar" | "sidebar" | "document" | "bottom" | "actions" | "doctabs";

/**
 * 文件页独占的布局槽位。
 *
 * 这些位置过去是 `FilesTab` 直接 `render={<WorkbenchFrame tree={…} editor={…} />}` 传进去的，
 * 于是「文件页」同时是「所有页面宿主」：进设置也得先下载带 Monaco 的 FilesTab，
 * 一个工具页抛错会连累整个工作台。改成 FilesTab 用 portal 往这几个容器里渲染之后，
 * 外层壳（WorkbenchShell）与文件页不再是父子关系，两者各自独立。
 */
export type FileSlotName = "tree" | "tabs" | "editor" | "status" | "output";

/** 当前工具的「文档页」入口：作为一个标签排在文件标签后面。 */
export interface DockToolTab {
  label: string;
  icon: IconName;
  /** 工具自己画多个文档标签（停靠到 `doctabs` 区），不用这一个固定标签。 */
  custom?: boolean;
  /** 按需工具可关闭入口并返回代码，其他工具沿用原有导航。 */
  onClose?: () => void;
}

export interface DockSlots {
  hosts: Record<DockRegionName, HTMLElement | null>;
  /** 文件页槽位（tree/tabs/editor/status/output）：由 FilesTab 用 portal 注入。 */
  fileHosts: Record<FileSlotName, HTMLElement | null>;
  bindFileSlot: (name: FileSlotName) => (node: HTMLElement | null) => void;
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
