// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchFrame } from "./WorkbenchFrame";
import { PanelTabs } from "./PanelTabs";
import { getWorkbenchLayout, restoreWorkbenchLayout, selectWorkbenchLayout, updateWorkbenchLayout } from "../../lib/workbenchLayout";
import { setSession } from "../../lib/workspaceSession";
import { setSidebarView } from "../../lib/sidebarView";
import { getToolReturn, recordToolNavigation, returnFromLogs } from "../../lib/toolReturn";

vi.mock("./DebugInspectorDock", () => ({ DebugInspectorDock: () => null }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { restoreWorkbenchLayout(); setSidebarView("files"); setSession({ panelOpen: true, panelTab: "problems", serviceExpanded: false }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); restoreWorkbenchLayout(); setSidebarView("files"); vi.restoreAllMocks(); });
const renderFrame = (activeTool = "files") => root.render(<WorkbenchFrame activeTool={activeTool} tree={null} tabs={<div>Tabs</div>} editor={<textarea defaultValue="draft" />} output={<div>Panel</div>} status={null} />);
describe("工作台任务布局", () => {
  it("服务展开后进入日志让出正文，返回后恢复展开且保留编辑节点", () => {
    recordToolNavigation("files");
    act(() => { renderFrame(); setSession({ panelOpen: true, panelTab: "svc" }); updateWorkbenchLayout({ expanded: "svc" }); });
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!; editor.value = "draft before logs";
    act(() => { recordToolNavigation("logs"); renderFrame("logs"); });
    expect(host.querySelector(".wb-main")?.hasAttribute("data-panel-expanded")).toBe(false);
    const onNavigate = (event: Event) => { const tool = (event as CustomEvent<string>).detail; recordToolNavigation(tool); renderFrame(tool); };
    window.addEventListener("ncforge-navigate", onNavigate);
    try {
      act(() => returnFromLogs());
      expect(getToolReturn().activeTool).toBe("files");
      expect(host.querySelector(".wb-main")?.hasAttribute("data-panel-expanded")).toBe(true);
      expect(host.querySelector("textarea")).toBe(editor); expect(editor.value).toBe("draft before logs");
    } finally { window.removeEventListener("ncforge-navigate", onNavigate); }
  });
  it("不同底部工具记忆各自高度，展开和恢复保持编辑节点及输入", () => {
    act(() => renderFrame());
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!; editor.value = "unsaved";
    act(() => { updateWorkbenchLayout({ heights: { problems: 180, svc: 390 } }); setSession({ panelTab: "svc" }); });
    expect(host.querySelector<HTMLElement>(".wb-bottom")?.style.height).toBe("390px");
    act(() => updateWorkbenchLayout({ expanded: "svc" }));
    // 展开态由 `.wb-main[data-panel-expanded]` + CSS 收起两个面；`hidden` 只留给
    // 「文档面占位」这一件事，混进来会同时隐藏代码面与文档面（主区纯白）。
    expect(host.querySelector<HTMLElement>(".wb-main")?.hasAttribute("data-panel-expanded")).toBe(true);
    expect(host.querySelector<HTMLElement>(".wb-code-surface")?.hidden).toBe(false);
    act(() => { updateWorkbenchLayout({ expanded: null }); setSession({ panelTab: "problems" }); });
    expect(host.querySelector<HTMLElement>(".wb-bottom")?.style.height).toBe("180px");
    expect(host.querySelector("textarea")).toBe(editor); expect(editor.value).toBe("unsaved");
    act(() => updateWorkbenchLayout({ expanded: "problems" }));
    expect(host.querySelector<HTMLElement>(".wb-main")?.hasAttribute("data-panel-expanded")).toBe(true);
    act(() => updateWorkbenchLayout({ expanded: null }));
    expect(host.querySelector<HTMLElement>(".wb-main")?.hasAttribute("data-panel-expanded")).toBe(false);
    expect(host.querySelector<HTMLElement>(".wb-code-surface")?.hidden).toBe(false);
  });
  it("编码布局正常输出默认200px，切换调试布局后可恢复", () => {
    act(() => renderFrame()); expect(host.querySelector<HTMLElement>(".wb-bottom")?.style.height).toBe("200px");
    act(() => selectWorkbenchLayout("debug")); expect(host.querySelector<HTMLElement>(".wb-bottom")?.style.height).toBe("260px");
    act(() => selectWorkbenchLayout("code")); expect(host.querySelector<HTMLElement>(".wb-bottom")?.style.height).toBe("200px");
  });
  it("文件树、搜索和数据库分别记忆宽度，切回时恢复本视图", () => {
    act(() => renderFrame());
    const separator = () => host.querySelector<HTMLElement>('[aria-label="调整侧栏宽度"]')!;
    const width = () => Number(separator().getAttribute("aria-valuenow"));
    const grow = () => act(() => separator().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(width()).toBe(240); grow(); expect(width()).toBe(250);
    act(() => setSidebarView("search")); expect(width()).toBe(320);
    grow(); expect(width()).toBe(330);
    act(() => setSidebarView("files")); expect(width()).toBe(250);
    // 数据库对象侧栏默认 236px（方案定的口径，比通用 240 窄一点给 SQL 与网格让位）
    act(() => renderFrame("db")); expect(width()).toBe(236);
    grow(); expect(width()).toBe(246);
    act(() => renderFrame()); expect(width()).toBe(250);
    act(() => setSidebarView("search")); expect(width()).toBe(330);
    expect(getWorkbenchLayout().sides).toEqual({ files: 250, search: 330, db: 246 });
  });
  it("启动后第一次 Enter 不复位尺寸，连续两次 Enter 才复位", () => {
    updateWorkbenchLayout({ sides: { files: 280 } });
    act(() => renderFrame());
    const separator = host.querySelector<HTMLElement>('[aria-label="调整侧栏宽度"]')!;
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(200);
    act(() => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(separator.getAttribute("aria-valuenow")).toBe("280");
    act(() => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(separator.getAttribute("aria-valuenow")).toBe("240");
  });
  it("次要工具通过更多打开并可固定，取消固定后当前工具仍可见", () => {
    const selected = vi.fn();
    act(() => root.render(<PanelTabs tab="problems" onTab={selected} errors={0} paused={false} />));
    // 常驻页签 5 个：问题 / 改动 / 编译输出 / NC 服务 / 调试（「改动」是审 AI 代码的主入口）
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(5);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="更多底部工具"]')!.click());
    const pin = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === "固定待办")!;
    act(() => pin.click()); expect(getWorkbenchLayout().pinned).toEqual(["todo"]);
    expect(host.querySelector("#wb-ptab-todo")).not.toBeNull();
    act(() => root.render(<PanelTabs tab="todo" onTab={selected} errors={0} paused={false} />));
    act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === "取消固定待办")!.click());
    expect(host.querySelector("#wb-ptab-todo")).not.toBeNull();
  });
});
