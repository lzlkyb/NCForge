// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { autoWorkbenchLayout, getWorkbenchLayout, panelHeight, parseWorkbenchLayout, restoreWorkbenchLayout, selectWorkbenchLayout, togglePinnedPanel, updateWorkbenchLayout } from "./workbenchLayout";
import { getSession } from "./workspaceSession";
import { getSideOpen } from "./layoutStore";

afterEach(() => restoreWorkbenchLayout());
describe("工作台布局偏好", () => {
  it("旧共享高度只迁移到常规输出，服务不会把高度带到其他工具", () => {
    const layout = parseWorkbenchLayout(null, JSON.stringify({ side: 255, bottom: 180 }));
    expect(layout.side).toBe(255);
    expect(panelHeight(layout, "problems", 900)).toBe(180);
    expect(panelHeight(layout, "svc", 900)).toBe(360);
    expect(panelHeight(layout, "debug", 900)).toBe(260);
  });
  it("只恢复可识别的工具偏好；异常值、重复固定与临时展开不会污染会话", () => {
    const layout = parseWorkbenchLayout(JSON.stringify({ side: 999, mode: "unknown", heights: { problems: -1, svc: 400, injected: 100 }, pinned: ["calls", "calls", "svc", "injected"], expanded: "svc", compact: false }));
    expect(layout).toMatchObject({ side: 420, mode: "code", pinned: ["calls"], expanded: null, compact: true });
    expect(layout.heights).toEqual({ problems: 140, svc: 400 });
    expect(panelHeight(layout, "svc", 400)).toBe(300);
  });
  it("低窗口服务保留默认阅读高度，同时尊重独立缩小的偏好", () => {
    const layout = parseWorkbenchLayout(null);
    expect(panelHeight(layout, "svc", 540)).toBe(360);
    expect(panelHeight({ ...layout, heights: { svc: 200 } }, "svc", 540)).toBe(200);
    expect(panelHeight(layout, "problems", 540)).toBe(200);
  });
  it("锁定仅阻止自动布局，用户仍能显式切换；恢复会清除尺寸与固定偏好", () => {
    restoreWorkbenchLayout();
    updateWorkbenchLayout({ locked: true, heights: { svc: 410 } });
    expect(autoWorkbenchLayout("debug")).toBe(false);
    expect(getWorkbenchLayout().mode).toBe("code");
    selectWorkbenchLayout("debug");
    expect(getSession().panelTab).toBe("debug");
    expect(getSideOpen()).toBe(false);
    togglePinnedPanel("calls"); expect(getWorkbenchLayout().pinned).toEqual(["calls"]);
    restoreWorkbenchLayout();
    expect(getWorkbenchLayout()).toMatchObject({ mode: "code", locked: false, compact: true, heights: {}, pinned: [] });
    expect(getSideOpen()).toBe(true);
  });
});
