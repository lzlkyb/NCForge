// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationMenu, LayoutMenu } from "./HeaderMenus";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { useWorkspacePicker } from "../../hooks/useWorkspacePicker";
import { getPalette, closePalette } from "../../lib/paletteStore";
import { getSideOpen, setSideOpen } from "../../lib/layoutStore";
import { getSidebarView, setSidebarView } from "../../lib/sidebarView";
import { rememberRoot } from "../../lib/recentRoots";
import { getSession, setSession } from "../../lib/workspaceSession";
import { clearSettingsRequest, getSettingsRequest } from "../../lib/settingsJump";
import { registerCommands } from "../../lib/commandRegistry";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let original: ReturnType<typeof getSession>;
let wasSideOpen: boolean;
let events: string[];
const navigate = (event: Event) => events.push((event as CustomEvent<string>).detail);
const applyRoot = vi.fn(async () => null);
const setDraft = vi.fn();
const setEditing = vi.fn();
function PickerBridge() {
  useWorkspacePicker({ root: "D:\\NC65", applyRoot, setDraft, setEditing });
  return <WorkspaceMenu />;
}
const trigger = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const item = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.startsWith(label))!;
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  original = getSession();
  wasSideOpen = getSideOpen();
  setSession({ root: "D:\\NC65", panelOpen: false, splitPath: null });
  setSideOpen(true);
  events = [];
  window.addEventListener("ncforge-navigate", navigate);
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  window.removeEventListener("ncforge-navigate", navigate);
  setSession({ root: original.root, panelOpen: original.panelOpen, splitPath: original.splitPath });
  setSideOpen(wasSideOpen);
  setSidebarView("files");
  closePalette(); clearSettingsRequest();
});

describe("一体化标题栏真实入口", () => {
  it("设置页布局菜单明确称为设置分类", () => {
    act(() => root.render(<LayoutMenu activeTool="settings" />));
    act(() => trigger("工作台布局").click());
    expect(item("设置分类")).toBeTruthy();
    expect(item("资源侧栏")).toBeUndefined();
    act(() => item("设置分类").click());
    expect(getSideOpen()).toBe(false);
  });
  it("日志排查通过应用菜单按需打开", () => {
    act(() => root.render(<ApplicationMenu />));
    act(() => trigger("应用菜单").click());
    act(() => item("日志排查").click());
    expect(events).toEqual(["logs"]);
    expect(document.querySelector('[role="menu"]:not([aria-hidden="true"])')).toBeNull();
  });
  it("应用菜单打开搜索并进入正确的命令模式", () => {
    act(() => root.render(<ApplicationMenu />));
    act(() => trigger("应用菜单").click());
    act(() => item("全工程搜索").click());
    expect(events).toEqual(["search"]);
    act(() => trigger("应用菜单").click());
    act(() => item("命令面板").click());
    expect(getPalette()).toMatchObject({ open: true, mode: "cmd" });
  });
  it("快捷键入口指定设置分类，布局菜单关闭后归还键盘焦点", () => {
    act(() => root.render(<><ApplicationMenu /><LayoutMenu /></>));
    act(() => trigger("应用菜单").click());
    act(() => item("快捷键").click());
    expect(getSettingsRequest()?.section).toBe("快捷键");
    expect(events).toEqual(["settings"]);
    act(() => trigger("工作台布局").click());
    act(() => { item("资源侧栏").focus(); item("资源侧栏").click(); });
    expect(getSideOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger("工作台布局"));
  });
  it("从搜索侧栏打开其他工作区时切回文件树，让目录输入实际可见", () => {
    setSidebarView("search");
    act(() => root.render(<PickerBridge />));
    act(() => trigger("选择工作区").click());
    act(() => item("打开其他工作区").click());
    expect(getSidebarView()).toBe("files");
    expect(setDraft).toHaveBeenCalledWith("D:\\NC65");
    expect(setEditing).toHaveBeenCalledWith(true);
    expect(events).toEqual(["files"]);
    expect(applyRoot).not.toHaveBeenCalled();
  });
  it("最近工作区交给已有保存与切换流程处理", () => {
    rememberRoot("D:\\NC65-test");
    act(() => root.render(<PickerBridge />));
    act(() => trigger("选择工作区").click());
    act(() => item("NC65-test").click());
    expect(applyRoot).toHaveBeenCalledExactlyOnceWith("D:\\NC65-test");
    expect(events).toEqual(["files"]);
  });
  it("从数据库选择代码分屏时回到代码页，让布局变化可见", () => {
    const run = vi.fn();
    const unregister = registerCommands([{ id: "tab.split", title: "代码分屏", run }]);
    try {
      act(() => root.render(<LayoutMenu activeTool="db" />));
      act(() => trigger("工作台布局").click());
      act(() => item("代码左右分屏").click());
      expect(run).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["files"]);
    } finally { unregister(); }
  });
});
