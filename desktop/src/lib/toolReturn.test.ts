// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSession, setSession } from "./workspaceSession";
import { getWorkbenchLayout, updateWorkbenchLayout } from "./workbenchLayout";
import { getSideOpen, setSideOpen } from "./layoutStore";
import { captureServiceReturn, getToolReturn, recordToolNavigation, returnFromLogs, returnFromService, takeRestoredTool, toolReturnLabel } from "./toolReturn";
import { pageSideEffect } from "./railNavigation";
import { openServicePanel } from "./servicePanel";

const navigate = (e: Event) => { const target = (e as CustomEvent<string>).detail; const active = getToolReturn().activeTool; recordToolNavigation(target); pageSideEffect(active, target); };
beforeEach(() => {
  window.addEventListener("ncforge-navigate", navigate);
  returnFromService(); returnFromLogs(); recordToolNavigation("files"); takeRestoredTool("files");
  setSession({ panelOpen: true, panelTab: "build", serviceExpanded: false });
  updateWorkbenchLayout({ expanded: null, compact: false }); setSideOpen(false);
});
afterEach(() => { window.removeEventListener("ncforge-navigate", navigate); vi.restoreAllMocks(); });
it("从数据库打开服务并返回，恢复来源面板与侧栏而不改写拖动尺寸", () => {
  recordToolNavigation("db");
  const before = { panelTab: getSession().panelTab, side: getSideOpen() };
  openServicePanel(); openServicePanel();
  expect(getToolReturn().service?.tool).toBe("db");
  expect(getSession().panelTab).toBe("svc");
  updateWorkbenchLayout({ expanded: "svc", side: 310 });
  returnFromService();
  expect(getToolReturn().activeTool).toBe("db");
  expect(getSession().panelTab).toBe(before.panelTab);
  expect(getSideOpen()).toBe(before.side);
  expect(getWorkbenchLayout().expanded).toBeNull();
  expect(getWorkbenchLayout().side).toBe(310);
});
it("服务展开后进入日志、跳数据库再返回日志，原服务来源不会被覆盖", () => {
  openServicePanel(); updateWorkbenchLayout({ expanded: "svc" });
  recordToolNavigation("logs");
  expect(toolReturnLabel(getToolReturn().logs)).toBe("NC 服务");
  updateWorkbenchLayout({ expanded: null });
  recordToolNavigation("db");
  expect(getToolReturn().logExcursion).toBe(true);
  recordToolNavigation("logs");
  expect(toolReturnLabel(getToolReturn().logs)).toBe("NC 服务");
  returnFromLogs();
  expect(getToolReturn().activeTool).toBe("files");
  expect(getWorkbenchLayout().expanded).toBe("svc");
  expect(takeRestoredTool("files")).toBe(true);
  expect(takeRestoredTool("files")).toBe(false);
  expect(getToolReturn().logExcursion).toBe(false);
});
it("连续导航按当前目标记录，服务返回来源不依赖上一帧", () => {
  recordToolNavigation("meta"); captureServiceReturn(); recordToolNavigation("files");
  expect(getToolReturn().service?.tool).toBe("meta");
  returnFromService(); expect(getToolReturn().activeTool).toBe("meta");
});
