import { useSyncExternalStore } from "react";
import { getSession, setSession } from "./workspaceSession";
import { getWorkbenchLayout, updateWorkbenchLayout } from "./workbenchLayout";
import { getSideOpen, setSideOpen } from "./layoutStore";
import { PAGES } from "./pages";

function capture() {
  const { panelOpen, panelTab, serviceExpanded } = getSession();
  const { expanded, compact } = getWorkbenchLayout();
  return { tool: state.activeTool, panelOpen, panelTab, serviceExpanded, expanded, compact, sideOpen: getSideOpen() };
}
type ViewReturn = ReturnType<typeof capture>;
interface ToolReturnState {
  activeTool: string;
  service: ViewReturn | null;
  logs: ViewReturn | null;
  logExcursion: boolean;
}
let state: ToolReturnState = { activeTool: "files", service: null, logs: null, logExcursion: false };
const listeners = new Set<() => void>();
let restoredTool: string | null = null;
const update = (patch: Partial<ToolReturnState>) => { state = { ...state, ...patch }; listeners.forEach(cb => cb()); };
export const getToolReturn = () => state;
export const useToolReturn = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, getToolReturn, getToolReturn);
export const toolReturnLabel = (view: ViewReturn | null) => view?.tool === "files" && view.panelOpen && view.panelTab === "svc" ? "NC 服务" : PAGES.find(p => p.key === (view?.tool ?? "files"))?.label ?? "代码";

/** 在导航入口同步记录，连续事件也不会读到上一帧的 React 闭包。 */
export function recordToolNavigation(target: string): void {
  if (target === state.activeTool) return;
  const logs = target === "logs" && !state.logExcursion ? capture() : state.logs;
  update({ activeTool: target, logs, logExcursion: target === "logs" ? false : state.activeTool === "logs" || state.logExcursion });
}
export function captureServiceReturn(): void {
  const session = getSession();
  if (state.activeTool === "files" && session.panelOpen && session.panelTab === "svc") return;
  update({ service: capture() });
}
function restore(view: ViewReturn): void {
  const changingTool = state.activeTool !== view.tool;
  window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: view.tool }));
  // 只恢复本次动线改变的布局；文件草稿、阅读位置和用户拖动的尺寸由原仓库保留。
  setSession({ panelOpen: view.panelOpen, panelTab: view.panelTab, serviceExpanded: view.serviceExpanded });
  updateWorkbenchLayout({ expanded: view.expanded, compact: view.compact });
  setSideOpen(view.sideOpen);
  restoredTool = changingTool ? view.tool : null;
}
/** 工作台切页时保留刚恢复的展开态，其余切页仍按原规则收起。 */
export function takeRestoredTool(tool: string): boolean {
  if (restoredTool !== tool) return false;
  restoredTool = null;
  return true;
}
export function returnFromService(): void {
  if (state.service) restore(state.service);
  update({ service: null });
}
export function returnFromLogs(): void {
  restore(state.logs ?? { ...capture(), tool: "files", expanded: null, serviceExpanded: false });
  update({ logs: null, logExcursion: false });
}
